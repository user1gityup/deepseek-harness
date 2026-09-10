#!/usr/bin/env node
/**
 * Antigravity seat pool: one signed-in account per standalone language server.
 *
 * The Antigravity IDE is not involved. `language_server.exe --standalone`
 * carries its own OAuth: with no session it prints a Google authorization URL
 * and reads the resulting code from stdin, then persists a refresh token under
 * whatever `-gemini_dir` it was given. Pointing each account at its own
 * absolute `-gemini_dir` therefore gives a fully isolated seat for ~178 MB,
 * against ~650 MB for an IDE instance, which is what makes a pool fit on a
 * 7.7 GB machine at all.
 *
 * Nothing here handles a credential. `add` hands the terminal to the language
 * server so the person signs in to Google themselves; this process never sees
 * the password, the authorization code or the token. The registry holds paths
 * and quota bookkeeping only.
 *
 * A seat started with `-persistent_mode` writes
 * `<geminiDir>/antigravity/daemon/ls_*.json` carrying its pid, both loopback
 * ports and its CSRF token. That file is the discovery mechanism: it replaces
 * scraping `language_server.exe` command lines, which cannot tell two seats
 * apart.
 *
 * Commands:
 *   add <id> [--label <text>]   create a seat and run its interactive login
 *   start <id> | --all          start seats as background daemons
 *   stop <id> | --all           stop seats
 *   status [--json]             per-seat quota, remaining fraction, reset time
 *   list [--json]               registry contents without touching the network
 *   remove <id> [--purge]       drop a seat, optionally deleting its session
 */

import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const LS_EXE =
  process.env['ANTIGRAVITY_LS_EXE'] ??
  join(
    process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'),
    'Programs',
    'antigravity',
    'resources',
    'bin',
    'language_server.exe',
  )

const ROOT = process.env['DSH_ANTIGRAVITY_ROOT'] ?? join(homedir(), '.dsh', 'antigravity')
const REGISTRY = join(ROOT, 'accounts.json')
const PROFILES = join(ROOT, 'profiles')

/**
 * Endpoints the IDE passes its own server. The standalone server defaults
 * `-api_server_url` to `http://0.0.0.0:50001`, which is an internal loopback
 * address and fails closed, so both must be supplied explicitly.
 */
const API_SERVER_URL = 'https://generativelanguage.googleapis.com'
const CLOUD_CODE_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com'

const RPC_BASE = '/exa.language_server_pb.LanguageServerService/'
const QUOTA_RPC = `${RPC_BASE}RetrieveUserQuotaSummary`
const STATUS_RPC = `${RPC_BASE}GetUserStatus`

/** Seat ids become directory names, so keep them to a conservative charset. */
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/

function fail(message) {
  process.stderr.write(`agy-profile: ${message}\n`)
  process.exit(1)
}

function ensureRoot() {
  mkdirSync(PROFILES, { recursive: true })
}

/**
 * Parse JSON written by something other than this tool.
 *
 * Windows editors and `Out-File -Encoding utf8` under PowerShell 5.1 both emit
 * a UTF-8 BOM, which `JSON.parse` rejects. The registry is meant to be
 * hand-editable, so the BOM is stripped rather than left to surface as an
 * empty seat list.
 */
export function parseJsonFile(path) {
  const text = readFileSync(path, 'utf8')
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
}

export function readRegistry() {
  if (!existsSync(REGISTRY)) return { seats: [] }
  try {
    const parsed = parseJsonFile(REGISTRY)
    return Array.isArray(parsed?.seats) ? parsed : { seats: [] }
  } catch {
    return { seats: [] }
  }
}

function writeRegistry(registry) {
  ensureRoot()
  writeFileSync(REGISTRY, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
}

function seatOf(registry, id) {
  return registry.seats.find((s) => s.id === id)
}

function geminiDirOf(seat) {
  return seat.geminiDir ?? join(PROFILES, seat.id)
}

/**
 * Read the discovery file a persistent seat writes on startup.
 *
 * The filename carries a hash that is stable for a given workspace, but a seat
 * is restarted often enough that a stale file can outlive its process, so the
 * newest is taken and the caller is expected to confirm the pid is alive.
 */
export function readDiscovery(geminiDir) {
  const dir = join(geminiDir, 'antigravity', 'daemon')
  if (!existsSync(dir)) return undefined
  let newest
  for (const name of readdirSync(dir)) {
    if (!name.startsWith('ls_') || !name.endsWith('.json')) continue
    const path = join(dir, name)
    let mtime
    try {
      mtime = statSync(path).mtimeMs
    } catch {
      continue
    }
    if (!newest || mtime > newest.mtime) newest = { path, mtime }
  }
  if (!newest) return undefined
  try {
    const parsed = parseJsonFile(newest.path)
    const httpPort = Number(parsed?.httpPort)
    const httpsPort = Number(parsed?.httpsPort)
    const pid = Number(parsed?.pid)
    const csrfToken = String(parsed?.csrfToken ?? '')
    if (!csrfToken || !Number.isInteger(pid) || pid <= 0) return undefined
    return {
      pid,
      csrfToken,
      httpPort: Number.isInteger(httpPort) && httpPort > 0 ? httpPort : undefined,
      httpsPort: Number.isInteger(httpsPort) && httpsPort > 0 ? httpsPort : undefined,
      path: newest.path,
    }
  } catch {
    return undefined
  }
}

/** A discovery file outlives its process, so liveness is checked separately. */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/**
 * Environment that pins a seat's Google account to its own directory.
 *
 * `-gemini_dir` isolates conversations, brain and config but NOT the account:
 * the standalone OAuth token is written to `<home>/.gemini/
 * jetski-standalone-oauth-token`, computed from the home directory and
 * ignoring the flag entirely. Every seat therefore read whichever account
 * logged in last, and three seats reported one email.
 *
 * Overriding the home variables moves that file inside the seat, which was
 * confirmed by starting a server under an overridden HOME and watching it
 * report `No valid authentication found ()` while the real profile stayed
 * signed in. Note that redirecting APPDATA/LOCALAPPDATA as well stops the
 * server booting at all, so only these four are touched.
 */
export function seatEnv(geminiDir) {
  return {
    ...process.env,
    USERPROFILE: geminiDir,
    HOME: geminiDir,
    HOMEDRIVE: geminiDir.slice(0, 2),
    HOMEPATH: geminiDir.slice(2),
  }
}

function baseArgs(geminiDir, csrfToken) {
  return [
    '--standalone',
    '--headless=true',
    '--override_ide_name',
    'antigravity',
    '--subclient_type',
    'hub',
    '--override_user_agent_name',
    'antigravity',
    '--http_server_port',
    '0',
    '--https_server_port',
    '0',
    '--csrf_token',
    csrfToken,
    '--gemini_dir',
    geminiDir,
    '--app_data_dir',
    'antigravity',
    '--api_server_url',
    API_SERVER_URL,
    '--cloud_code_endpoint',
    CLOUD_CODE_ENDPOINT,
  ]
}

/**
 * Ask one seat for its quota.
 *
 * The call starts no model turn and costs nothing, so polling is fine. An
 * unauthenticated seat answers HTTP 500 with `You are not logged into
 * Antigravity`, which is reported as `signed-out` rather than as a failure:
 * it is the normal state of a seat whose refresh token has expired.
 */
/**
 * Call one Connect RPC on a seat, trying each loopback port it advertises.
 *
 * A seat listens on two ports and the discovery file does not say which one
 * serves plain HTTP; the other answers HTTP 400 for every request. Trying both
 * is cheap and neither costs a model turn.
 */
async function callRpc(discovery, rpc, timeoutMs) {
  const ports = [discovery.httpPort, discovery.httpsPort].filter((p) => Number.isInteger(p))
  let lastError = 'no loopback port in discovery file'
  for (const port of ports) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`http://127.0.0.1:${port}${rpc}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'connect-protocol-version': '1',
          'x-codeium-csrf-token': discovery.csrfToken,
        },
        body: '{}',
        signal: controller.signal,
      })
      const text = await res.text()
      if (res.ok) return { ok: true, text, port }
      if (/not logged into Antigravity/i.test(text)) return { ok: false, signedOut: true, port }
      lastError = `HTTP ${res.status} ${text.slice(0, 200)}`
    } catch (err) {
      lastError = err?.message ?? String(err)
    } finally {
      clearTimeout(timer)
    }
  }
  return { ok: false, error: lastError }
}

export async function fetchQuota(discovery, timeoutMs = 20_000) {
  const res = await callRpc(discovery, QUOTA_RPC, timeoutMs)
  if (res.ok) return { state: 'ok', buckets: bucketsFrom(res.text), port: res.port }
  if (res.signedOut) return { state: 'signed-out', port: res.port }
  return { state: 'error', error: res.error }
}

/**
 * Which Google account a seat actually holds.
 *
 * Worth surfacing next to the quota: a seat created from a browser that was
 * already signed in silently inherits that account, and two seats on one
 * account share a quota bucket while looking like two seats.
 */
export async function fetchIdentity(discovery, timeoutMs = 20_000) {
  const res = await callRpc(discovery, STATUS_RPC, timeoutMs)
  if (!res.ok) return undefined
  return identityFrom(res.text)
}

/**
 * The Antigravity quota tier lives in `userTier`, not in `planStatus`.
 *
 * `planStatus.planInfo` is inherited Codeium/Windsurf plan scaffolding and
 * reports `planName: "Pro"` with `TEAMS_TIER_PRO` even for an account whose
 * `userTier.id` is `free-tier`. Reading it labels every free seat "Pro", which
 * is exactly backwards for a router deciding where to send work.
 */
export function identityFrom(body) {
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  const status = parsed?.userStatus ?? parsed
  const email = status?.email
  if (!email) return undefined
  const userTier = status?.userTier
  return {
    email: String(email),
    name: String(status?.name ?? ''),
    tierId: String(userTier?.id ?? ''),
    tierName: String(userTier?.name ?? ''),
    // Present only when the account is barred from a Google AI plan's higher
    // limits, and the one field that says a subscription is not being applied.
    ineligibleNote: userTier?.upgradeSubscriptionText ? String(userTier.upgradeSubscriptionText) : '',
  }
}

/**
 * Flatten the quota summary to the fields a router needs.
 *
 * The Gemini bucket refreshes weekly, not on a shift-length window, so
 * `resetTime` is days out and has to be carried through rather than treated
 * as a retry-after.
 */
export function bucketsFrom(body) {
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  const groups = parsed?.response?.groups ?? parsed?.groups ?? []
  const out = []
  for (const group of Array.isArray(groups) ? groups : []) {
    for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
      out.push({
        group: String(group?.displayName ?? ''),
        bucketId: String(bucket?.bucketId ?? ''),
        window: String(bucket?.window ?? ''),
        remainingFraction: Number(bucket?.remainingFraction ?? 0),
        resetTime: String(bucket?.resetTime ?? ''),
      })
    }
  }
  return out
}

function startSeat(seat) {
  const geminiDir = geminiDirOf(seat)
  const existing = readDiscovery(geminiDir)
  if (existing && isAlive(existing.pid)) return { started: false, pid: existing.pid }
  mkdirSync(geminiDir, { recursive: true })
  const csrfToken = randomUUID()
  const child = spawn(LS_EXE, [...baseArgs(geminiDir, csrfToken), '--persistent_mode=true'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: seatEnv(geminiDir),
  })
  child.unref()
  return { started: true, pid: child.pid }
}

async function waitForDiscovery(geminiDir, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = readDiscovery(geminiDir)
    if (found && isAlive(found.pid)) return found
    await new Promise((r) => setTimeout(r, 500))
  }
  return undefined
}

function stopSeat(seat) {
  const discovery = readDiscovery(geminiDirOf(seat))
  if (!discovery || !isAlive(discovery.pid)) return { stopped: false }
  const res = spawnSync('taskkill', ['/PID', String(discovery.pid), '/T', '/F'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  })
  return { stopped: res.status === 0, pid: discovery.pid }
}

/**
 * Create a seat and hand the terminal to its language server for login.
 *
 * stdio is inherited deliberately. The server prints the Google authorization
 * URL and blocks reading the code from stdin; the person completes that
 * exchange directly with Google. Piping it would mean this process brokering
 * an authorization code, which it has no reason to touch.
 */
function cmdAdd(argv) {
  const id = argv[0]
  if (!id || !ID_PATTERN.test(id)) fail('add needs an id matching [a-z0-9][a-z0-9_-]{0,31}')
  const labelIndex = argv.indexOf('--label')
  const label = labelIndex >= 0 ? argv[labelIndex + 1] : id

  const registry = readRegistry()
  if (seatOf(registry, id)) fail(`seat "${id}" already exists — use "login ${id}" to re-authenticate it`)

  const geminiDir = join(PROFILES, id)
  mkdirSync(geminiDir, { recursive: true })

  // Registered before the login runs, not after. The login server holds the
  // terminal until it is interrupted, and an interrupt that reaches this
  // process too would otherwise leave a signed-in session on disk that no
  // registry entry points at.
  registry.seats.push({ id, label, geminiDir, addedAt: new Date().toISOString() })
  writeRegistry(registry)
  process.stderr.write(`Seat "${id}" registered at ${geminiDir}\n`)

  return runLogin({ id, label, geminiDir })
}

/**
 * Run the interactive Google login for one seat.
 *
 * stdio is inherited deliberately. The server prints the authorization URL and
 * blocks reading the code from stdin; the person completes that exchange
 * directly with Google. Piping it would mean this process brokering an
 * authorization code, which it has no reason to touch.
 *
 * Also the re-auth path: Google eventually expires the refresh token, at which
 * point `status` reports the seat `signed-out` and this is what clears it.
 */
/** Chromium browsers that accept `--user-data-dir`, most preferred first. */
const BROWSERS = [
  join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env['LOCALAPPDATA'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
]

/**
 * Open the authorization URL in a throwaway browser profile.
 *
 * A private window is not enough: Chromium shares one private session across
 * windows, so a second seat's login silently reuses the first seat's Google
 * account and the two seats end up on one quota bucket. A fresh
 * `--user-data-dir` has no signed-in accounts at all, which forces the account
 * chooser every time.
 */
function openIsolatedBrowser(url, seatId) {
  const exe = BROWSERS.find((p) => p && existsSync(p))
  if (!exe) {
    process.stderr.write('\n[no Chrome or Edge found — open the URL above in a private window yourself]\n')
    return
  }
  const profile = join(tmpdir(), `agy-login-${seatId}-${Date.now()}`)
  const child = spawn(exe, [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.unref()
  // Plain ASCII: the Windows console codepage mangles an em dash to mojibake.
  process.stderr.write(`\n[opened a clean browser window for "${seatId}" - sign in there, then paste the code below]\n`)
}

const AUTH_URL = /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?[^\s"']+/
const ANSI = new RegExp('\u001b\\[[0-9;]*m', 'g')

function runLogin(seat) {
  const geminiDir = geminiDirOf(seat)

  // A running daemon holds the session directory; a second server against the
  // same directory would race it.
  const running = readDiscovery(geminiDir)
  if (running && isAlive(running.pid)) {
    process.stderr.write(`Stopping running seat "${seat.id}" (pid ${running.pid}) before login\n`)
    stopSeat(seat)
  }

  process.stderr.write(
    `\n=== SIGNING IN SEAT "${seat.id}" ===\n` +
      `A clean browser window will open on the Google consent screen.\n` +
      `Sign in there, copy the code Google gives you, and paste it at the\n` +
      `"Enter the authorization code:" prompt in THIS terminal.\n` +
      `Signing into the Antigravity IDE does nothing for this seat.\n` +
      `No password or code is stored by this tool.\n\n`,
  )

  return new Promise((resolve) => {
    // stdout is piped so the authorization URL can be spotted and opened;
    // stdin stays inherited so the code prompt still reads from the terminal.
    const child = spawn(LS_EXE, baseArgs(geminiDir, randomUUID()), {
      stdio: ['inherit', 'pipe', 'inherit'],
      windowsHide: false,
      env: seatEnv(geminiDir),
    })
    let opened = false
    let carry = ''
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk)
      if (opened) return
      // The URL can straddle two chunks, so a short tail is carried over.
      carry = (carry + chunk.toString('utf8')).replace(ANSI, '').slice(-4000)
      const match = AUTH_URL.exec(carry)
      if (match) {
        opened = true
        openIsolatedBrowser(match[0], seat.id)
      }
    })
    child.on('error', (err) => {
      process.stderr.write(`agy-profile: could not start language server: ${err.message}\n`)
      resolve()
    })
    child.on('exit', () => {
      process.stderr.write(`\nLogin session for "${seat.id}" ended. Check it with: agy-profile status\n`)
      resolve()
    })
  })
}

function cmdLogin(argv) {
  const id = argv[0]
  if (!id) fail('login needs a seat id')
  const seat = seatOf(readRegistry(), id)
  if (!seat) fail(`no seat "${id}" — create it with: agy-profile add ${id}`)
  return runLogin(seat)
}

function cmdStart(argv) {
  const registry = readRegistry()
  const all = argv.includes('--all')
  const targets = all ? registry.seats : registry.seats.filter((s) => argv.includes(s.id))
  if (targets.length === 0) fail('start needs a seat id or --all')
  for (const seat of targets) {
    const { started, pid } = startSeat(seat)
    process.stdout.write(`${seat.id}: ${started ? 'started' : 'already running'} pid ${pid ?? '?'}\n`)
  }
}

function cmdStop(argv) {
  const registry = readRegistry()
  const all = argv.includes('--all')
  const targets = all ? registry.seats : registry.seats.filter((s) => argv.includes(s.id))
  if (targets.length === 0) fail('stop needs a seat id or --all')
  for (const seat of targets) {
    const { stopped, pid } = stopSeat(seat)
    process.stdout.write(`${seat.id}: ${stopped ? `stopped pid ${pid}` : 'not running'}\n`)
  }
}

function cmdList(argv) {
  const registry = readRegistry()
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(registry, null, 2)}\n`)
    return
  }
  if (registry.seats.length === 0) {
    process.stdout.write('no seats registered\n')
    return
  }
  for (const seat of registry.seats) {
    const discovery = readDiscovery(geminiDirOf(seat))
    const live = discovery && isAlive(discovery.pid)
    process.stdout.write(`${seat.id}\t${seat.label}\t${live ? `up pid ${discovery.pid}` : 'down'}\n`)
  }
}

async function cmdStatus(argv) {
  const registry = readRegistry()
  const rows = []
  for (const seat of registry.seats) {
    const discovery = readDiscovery(geminiDirOf(seat))
    if (!discovery || !isAlive(discovery.pid)) {
      rows.push({ id: seat.id, label: seat.label, state: 'down' })
      continue
    }
    const quota = await fetchQuota(discovery)
    const identity = quota.state === 'ok' ? await fetchIdentity(discovery) : undefined
    rows.push({ id: seat.id, label: seat.label, pid: discovery.pid, ...quota, identity })
  }

  // Two seats on one Google account share a quota bucket while presenting as
  // two seats, which makes the pool look larger than it is. The usual cause is
  // a login run in a browser already signed into another seat's account.
  const byEmail = new Map()
  for (const row of rows) {
    const email = row.identity?.email
    if (!email) continue
    byEmail.set(email, [...(byEmail.get(email) ?? []), row.id])
  }
  const collisions = [...byEmail.entries()].filter(([, ids]) => ids.length > 1)
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
    return
  }
  if (rows.length === 0) {
    process.stdout.write('no seats registered\n')
    return
  }
  for (const row of rows) {
    if (row.state !== 'ok') {
      process.stdout.write(`${row.id}\t${row.state}${row.error ? `\t${row.error}` : ''}\n`)
      continue
    }
    const who = row.identity
      ? `${row.identity.email}${row.identity.tierName ? ` [${row.identity.tierName}]` : ''}`
      : 'account unknown'
    process.stdout.write(`${row.id}\t${who}\n`)
    for (const bucket of row.buckets) {
      const pct = (bucket.remainingFraction * 100).toFixed(1)
      process.stdout.write(`  ${bucket.bucketId}\t${pct}% left\tresets ${bucket.resetTime}\n`)
    }
  }
  for (const [email, ids] of collisions) {
    process.stdout.write(`WARNING: seats ${ids.join(', ')} all use ${email} and share one quota bucket\n`)
  }
}

function cmdRemove(argv) {
  const id = argv[0]
  if (!id) fail('remove needs a seat id')
  const registry = readRegistry()
  const seat = seatOf(registry, id)
  if (!seat) fail(`no seat "${id}"`)
  stopSeat(seat)
  if (argv.includes('--purge')) {
    rmSync(geminiDirOf(seat), { recursive: true, force: true })
    process.stdout.write(`${id}: session directory deleted\n`)
  }
  registry.seats = registry.seats.filter((s) => s.id !== id)
  writeRegistry(registry)
  process.stdout.write(`${id}: removed from registry\n`)
}

const USAGE = `agy-profile — Antigravity seat pool

  add <id> [--label <text>]   create a seat and run its interactive Google login
  login <id>                  re-authenticate an existing seat
  start <id> | --all          start seats as background daemons
  stop <id> | --all           stop seats
  status [--json]             per-seat quota and reset time
  list [--json]               registry contents, no network
  remove <id> [--purge]       drop a seat, --purge deletes its session

Root: ${ROOT}
`

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  switch (command) {
    case 'add':
      return cmdAdd(rest)
    case 'login':
      return cmdLogin(rest)
    case 'start':
      return cmdStart(rest)
    case 'stop':
      return cmdStop(rest)
    case 'status':
      return cmdStatus(rest)
    case 'list':
      return cmdList(rest)
    case 'remove':
      return cmdRemove(rest)
    default:
      process.stdout.write(USAGE)
      if (command && command !== '--help' && command !== '-h') process.exit(1)
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())
if (invokedDirectly) {
  main().catch((err) => fail(err?.message ?? String(err)))
}
