/**
 * Read Antigravity's remaining subscription quota from its own language server.
 *
 * Antigravity keeps no allowance figure on disk: the IDE asks its bundled
 * `language_server.exe` for `RetrieveUserQuotaSummary` over a loopback Connect
 * endpoint, and that answer is the only source of the real percentages. The
 * server is started by the IDE with an ephemeral port and a per-run CSRF token,
 * so a reader has to find the running process rather than pick a fixed port.
 *
 * Nothing here starts a model turn: the call is local, free, and returns the
 * same figures the IDE's own quota page shows.
 */

import { spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

/** One metered bucket inside a model group. */
export interface QuotaBucket {
  /** Provider bucket identifier, unique within a reading. */
  id: string
  /** Model group the bucket meters, as the provider worded it. */
  group: string
  /** Bucket label, or its identifier. */
  label: string
  /** Percentage remaining, clamped to the displayed range. */
  remaining: number
  /** Window name the provider reported, such as `weekly`. */
  window: string | null
  /** Reset timestamp in Unix seconds. */
  resetsAt: number | null
  /** Provider's own sentence about this bucket, trimmed. */
  note: string | null
}

/** A language server found running on this machine. */
export interface DiscoveredServer {
  /** Process identifier the ports were resolved from. */
  pid: number
  /** Per-run CSRF token the server requires on every call. */
  token: string
  /** Loopback ports the process is listening on. */
  ports: number[]
}

/** The account facts `GetUserStatus` carries, reduced to what the pool needs. */
export interface AccountStatus {
  /**
   * Lower-cased account email, used only to count one Google account once when
   * two servers are signed in to it. It is never published to settings.
   */
  account: string | undefined
  /** `userTier.id`, such as `free-tier` or `g1-plus-tier`; empty when unknown. */
  tierId: string
  /** The tier's display name; empty when unknown. */
  tierName: string
}

/** Connect endpoint the quota summary is served from. */
export const QUOTA_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'
/** Connect endpoint the signed-in account and its tier are served from. */
export const STATUS_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus'
/** Failure message for a server that answers but holds no signed-in account. */
export const SIGNED_OUT_MESSAGE = 'Antigravity is not signed in'
/** Failure message when discovery finds no IDE language server at all. */
export const NO_SERVER_MESSAGE = 'No running Antigravity language server found'
/** Longest provider sentence kept per bucket. */
const NOTE_LIMIT = 240

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, NOTE_LIMIT) : null
}
/** ISO-8601 reset stamps become Unix seconds; anything else stays unknown. */
function resetSeconds(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed / 1000) : null
}

/**
 * Normalize a `RetrieveUserQuotaSummary` answer into flat buckets.
 *
 * Groups carry the label a person recognizes ("Gemini Models"), buckets carry
 * the reading, so the two are flattened into one row per bucket rather than
 * modelled as a tree the panel would have to walk.
 * @param value - Untrusted Connect response body.
 * @returns Buckets with a usable fraction; malformed rows are dropped.
 */
export function parseQuotaSummary(value: unknown): QuotaBucket[] {
  const body = record(value)
  if (!body) throw new Error('Invalid Antigravity quota response')
  const response = record(body.response) ?? body
  const groups = Array.isArray(response.groups) ? response.groups : []
  const rows: QuotaBucket[] = []
  for (const rawGroup of groups) {
    const group = record(rawGroup)
    if (!group) continue
    const label = text(group.displayName) ?? ''
    const buckets = Array.isArray(group.buckets) ? group.buckets : []
    for (const rawBucket of buckets) {
      const bucket = record(rawBucket)
      if (!bucket || !finite(bucket.remainingFraction)) continue
      const id = text(bucket.bucketId)
      rows.push({
        id: id ?? `${label || 'group'}:${rows.length}`,
        group: label,
        label: text(bucket.displayName) ?? id ?? '',
        // The provider reports a fraction; one decimal is as fine as the IDE shows.
        remaining: Math.round(Math.max(0, Math.min(1, bucket.remainingFraction)) * 1000) / 10,
        window: text(bucket.window),
        resetsAt: resetSeconds(bucket.resetTime),
        note: text(bucket.description),
      })
    }
  }
  return rows
}

/**
 * Normalize a `GetUserStatus` answer to the account and its tier.
 *
 * The tier is read from `userTier`, never from `planStatus.planInfo`: that
 * field is inherited Codeium plan scaffolding and reports "Pro" for accounts
 * whose real Antigravity tier is `free-tier`.
 * @param value - Untrusted Connect response body.
 * @returns the account key and tier; empty fields when the answer carries none.
 */
export function parseUserStatus(value: unknown): AccountStatus {
  const body = record(value)
  const status = record(body?.userStatus) ?? body
  const tier = record(status?.userTier)
  const email = status?.email
  return {
    account: typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : undefined,
    tierId: typeof tier?.id === 'string' ? tier.id : '',
    tierName: text(tier?.name) ?? '',
  }
}

/**
 * Read the CSRF token out of the IDE language server's command line.
 *
 * Pool seats started by `agy-profile.mjs` are language servers too, and their
 * command lines also name Antigravity and carry a CSRF token. Each is started
 * with `--gemini_dir` and the IDE's own server is not, so that flag is what
 * keeps a seat's account from being reported as the IDE's. Seats are read
 * from the pool registry instead.
 * @param command - Full command line of a candidate process.
 * @returns the token, or undefined when this is not the IDE's Antigravity server.
 */
export function tokenOf(command: string): string | undefined {
  if (!/language_server/i.test(command) || !/antigravity/i.test(command)) return undefined
  if (/(?:^|\s)--?gemini_dir(?:=|\s)/i.test(command)) return undefined
  return /--csrf[_-]token(?:=|\s+)\s*["']?([a-z0-9._-]{8,})/i.exec(command)?.[1]
}

/**
 * Parse the Windows discovery payload: one JSON row per language server.
 * @param json - `ConvertTo-Json` output, or an empty string when the probe failed.
 * @returns Servers carrying both a token and at least one listening port.
 */
export function parseWindowsServers(json: string): DiscoveredServer[] {
  let parsed: unknown
  try { parsed = JSON.parse(json) } catch { return [] }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows.flatMap((raw): DiscoveredServer[] => {
    const row = record(raw)
    const command = typeof row?.cmd === 'string' ? row.cmd : ''
    const token = tokenOf(command)
    if (!row || token === undefined || (!finite(row.pid) || !Number.isInteger(row.pid) || row.pid <= 0)) return []
    const ports = (Array.isArray(row.ports) ? row.ports : [row.ports])
      .filter(finite).filter(port => Number.isInteger(port) && port > 0 && port < 65_536)
    return ports.length ? [{ pid: row.pid, token, ports }] : []
  })
}

/**
 * Parse `ps` output into candidate servers, before their ports are known.
 * @param listing - `ps -eo pid=,args=` output.
 * @returns One entry per Antigravity language server, with no ports yet.
 */
export function parsePosixProcesses(listing: string): { pid: number; token: string }[] {
  return listing.split('\n').flatMap((line): { pid: number; token: string }[] => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    const command = match?.[2]
    if (!match?.[1] || command === undefined) return []
    const token = tokenOf(command)
    return token === undefined ? [] : [{ pid: Number(match[1]), token }]
  })
}

/**
 * Parse listening ports out of `lsof` output for one process.
 * @param listing - `lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN` output.
 * @returns Distinct loopback ports.
 */
export function parseLsofPorts(listing: string): number[] {
  const ports = new Set<number>()
  for (const match of listing.matchAll(/:(\d{2,5})\s*\(LISTEN\)/g)) {
    const port = Number(match[1])
    if (port > 0 && port < 65_536) ports.add(port)
  }
  return [...ports]
}

/** PowerShell finds both the command line and the listening ports in one child. */
const WINDOWS_PROBE = `$ErrorActionPreference='SilentlyContinue'
$rows = @()
foreach ($p in Get-CimInstance Win32_Process -Filter "Name='language_server.exe'") {
  $ports = @(Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -eq $p.ProcessId } | ForEach-Object { $_.LocalPort })
  $rows += [pscustomobject]@{ pid = $p.ProcessId; cmd = $p.CommandLine; ports = $ports }
}
ConvertTo-Json -Compress -Depth 4 @($rows)`

/**
 * Run a discovery command and collect its stdout.
 *
 * No shell is opened, output is bounded, and a probe that hangs is killed
 * rather than left holding a process open behind the panel.
 * @param file - Executable to run.
 * @param args - Arguments passed verbatim.
 * @param timeoutMs - Hard deadline for this probe.
 * @param signal - Plugin disposal cancels the child.
 * @returns stdout, or an empty string when the probe failed.
 */
function probe(file: string, args: string[], timeoutMs: number, signal: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(''); return }
    let child
    try {
      child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], shell: false })
    } catch { resolve(''); return }
    let out = ''
    const stop = (): void => { child.kill() }
    const timer = setTimeout(stop, timeoutMs)
    signal.addEventListener('abort', stop, { once: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
      // A discovery listing is kilobytes; anything larger is not this listing.
      if (out.length > 256 * 1024) { out = out.slice(0, 256 * 1024); stop() }
    })
    child.on('error', () => { clearTimeout(timer); signal.removeEventListener('abort', stop); resolve('') })
    child.on('close', () => { clearTimeout(timer); signal.removeEventListener('abort', stop); resolve(out) })
  })
}

/**
 * Find every IDE Antigravity language server running for this user.
 * @param timeoutMs - Hard deadline for the whole discovery.
 * @param signal - Plugin disposal cancels the probes.
 * @returns Servers with a token and at least one listening port.
 */
export async function discoverServers(timeoutMs: number, signal: AbortSignal): Promise<DiscoveredServer[]> {
  if (process.platform === 'win32') {
    return parseWindowsServers(await probe('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROBE], timeoutMs, signal))
  }
  const candidates = parsePosixProcesses(await probe('ps', ['-eo', 'pid=,args='], timeoutMs, signal))
  const servers: DiscoveredServer[] = []
  const deadline = Date.now() + timeoutMs
  for (const candidate of candidates) {
    if (signal.aborted || Date.now() >= deadline) break
    const ports = parseLsofPorts(await probe('lsof',
      ['-nP', '-a', '-p', String(candidate.pid), '-iTCP', '-sTCP:LISTEN'], Math.max(1, deadline - Date.now()), signal))
    if (ports.length) servers.push({ ...candidate, ports })
  }
  return servers
}

/** One address a quota read can be attempted against. */
export interface Endpoint {
  /** Loopback host; never anything routable. */
  host: string
  /** Port the language server answers on. */
  port: number
  /** TLS, which the server uses on one of its two ports. */
  secure: boolean
}

/** Only loopback addresses may carry the token. */
function loopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
}

/**
 * Turn a configured endpoint override into an address, refusing remote hosts.
 * @param value - Endpoint URL from settings, empty when unset.
 * @returns the address, or undefined when unset or not loopback.
 */
export function parseEndpoint(value: string): Endpoint | undefined {
  if (!value.trim()) return undefined
  let url: URL
  try { url = new URL(value.trim()) } catch { return undefined }
  if (!loopback(url.hostname) && !loopback(`[${url.hostname}]`)) return undefined
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return undefined
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  const secure = url.protocol === 'https:'
  const port = Number(url.port || (secure ? 443 : 80))
  return Number.isFinite(port) && port > 0 && port < 65_536
    ? { host: url.hostname.replace(/^\[|\]$/g, ''), port, secure } : undefined
}

/**
 * Call one Connect method on one endpoint and return its parsed JSON body.
 *
 * The server presents a self-signed certificate on its TLS port, so
 * verification is off — the connection never leaves loopback, and the token it
 * carries came from a process owned by this same user.
 * @param endpoint - Loopback address to call.
 * @param token - Per-run CSRF token.
 * @param path - Connect method path.
 * @param timeoutMs - Hard deadline for this call.
 * @param signal - Plugin disposal aborts the request.
 * @returns the parsed body.
 */
export function callEndpoint(endpoint: Endpoint, token: string, path: string, timeoutMs: number, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Antigravity quota read cancelled')); return }
    if (!loopback(endpoint.host)) { reject(new Error('Antigravity endpoint must be loopback')); return }
    const body = '{}'
    const send = endpoint.secure ? httpsRequest : httpRequest
    const request = send({
      host: endpoint.host,
      port: endpoint.port,
      method: 'POST',
      path,
      headers: {
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        'x-codeium-csrf-token': token,
        'content-length': String(Buffer.byteLength(body)),
      },
      ...(endpoint.secure ? { rejectUnauthorized: false } : {}),
    }, (response) => {
      let answer = ''
      let bytes = 0
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk, 'utf8')
        if (bytes > 1024 * 1024) { request.destroy(new Error('Antigravity quota response exceeded 1 MiB')); return }
        answer += chunk
      })
      response.on('error', reject)
      response.on('end', () => {
        if (response.statusCode !== 200) {
          // A signed-out server answers HTTP 500 with this sentence; it is the
          // normal state of a seat whose refresh token lapsed, not a fault.
          reject(new Error(/not logged into Antigravity/i.test(answer)
            ? SIGNED_OUT_MESSAGE : `Antigravity quota read returned ${String(response.statusCode)}`))
          return
        }
        try { resolve(JSON.parse(answer)) }
        catch { reject(new Error('Invalid Antigravity quota response')) }
      })
    })
    const abort = (): void => { request.destroy(new Error('Antigravity quota read cancelled')) }
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => { request.destroy(new Error('Antigravity quota read timed out')) }, timeoutMs)
    request.on('error', (error: Error) => { signal.removeEventListener('abort', abort); reject(error) })
    request.on('close', () => { clearTimeout(timer); signal.removeEventListener('abort', abort) })
    request.end(body)
  })
}

/**
 * Ask one endpoint for the quota summary.
 * @param endpoint - Loopback address to call.
 * @param token - Per-run CSRF token.
 * @param timeoutMs - Hard deadline for this call.
 * @param signal - Plugin disposal aborts the request.
 * @returns the parsed buckets.
 */
export async function readEndpoint(endpoint: Endpoint, token: string, timeoutMs: number, signal: AbortSignal): Promise<QuotaBucket[]> {
  return parseQuotaSummary(await callEndpoint(endpoint, token, QUOTA_PATH, timeoutMs, signal))
}

/** The IDE server's quota plus the account it is signed in to. */
export interface IdeReading extends AccountStatus {
  /** Buckets the IDE's account reports. */
  buckets: QuotaBucket[]
}

/**
 * Read the quota summary and account from the running Antigravity IDE, trying
 * each address it listens on: one port speaks TLS and the other plain HTTP, and
 * which is which is not announced anywhere.
 * The CSRF token is never configurable: it changes every time Antigravity
 * starts, and a stale one in settings would be a secret kept for nothing.
 * @param endpointOverride - Configured loopback endpoint, empty to discover.
 * @param timeoutMs - Hard deadline for one whole read.
 * @param signal - Plugin disposal cancels discovery and the call.
 * @returns Buckets and account from the first address that answers.
 */
export async function readIde(
  endpointOverride: string, timeoutMs: number, signal: AbortSignal,
): Promise<IdeReading> {
  const deadline = Date.now() + timeoutMs
  const left = (): number => Math.max(1, deadline - Date.now())
  const pinned = parseEndpoint(endpointOverride)
  if (endpointOverride.trim() && !pinned) throw new Error('Antigravity endpoint must be a loopback HTTP(S) URL')
  const attempts: { endpoint: Endpoint; token: string }[] = []
  for (const server of await discoverServers(Math.min(timeoutMs, left()), signal)) {
    // A pinned endpoint is tried first, still with the token the running
    // server was started with; the discovered addresses remain the fallback.
    if (pinned) attempts.push({ endpoint: pinned, token: server.token })
    for (const port of server.ports) {
      attempts.push({ endpoint: { host: '127.0.0.1', port, secure: true }, token: server.token })
      attempts.push({ endpoint: { host: '127.0.0.1', port, secure: false }, token: server.token })
    }
  }
  if (!attempts.length) throw new Error(NO_SERVER_MESSAGE)
  let failure: Error | undefined
  for (const attempt of attempts) {
    if (signal.aborted) throw new Error('Antigravity quota read cancelled')
    if (Date.now() >= deadline) throw new Error('Antigravity quota read timed out')
    let buckets: QuotaBucket[]
    try { buckets = await readEndpoint(attempt.endpoint, attempt.token, Math.min(2000, left()), signal) }
    catch (error) { failure = error instanceof Error ? error : new Error('Antigravity quota read failed'); continue }
    let status: AccountStatus = { account: undefined, tierId: '', tierName: '' }
    try { status = parseUserStatus(await callEndpoint(attempt.endpoint, attempt.token, STATUS_PATH, Math.min(2000, left()), signal)) }
    catch { /* The account only de-duplicates and labels; the quota stands without it. */ }
    return { buckets, ...status }
  }
  throw failure ?? new Error('Antigravity quota read failed')
}

/**
 * Read the quota summary from the running Antigravity IDE.
 * @param endpointOverride - Configured loopback endpoint, empty to discover.
 * @param timeoutMs - Hard deadline for one whole read.
 * @param signal - Plugin disposal cancels discovery and the call.
 * @returns Buckets from the first address that answers.
 */
export async function readQuota(
  endpointOverride: string, timeoutMs: number, signal: AbortSignal,
): Promise<QuotaBucket[]> {
  return (await readIde(endpointOverride, timeoutMs, signal)).buckets
}
