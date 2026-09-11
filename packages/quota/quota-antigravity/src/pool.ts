/**
 * Read every Antigravity account on this machine and fold them into one figure.
 *
 * An account is either the running IDE's own language server or a seat in the
 * `agy-profile.mjs` pool: a standalone server signed in to its own Google
 * account, recorded in `<root>/accounts.json` and announcing its loopback ports
 * and CSRF token in `<geminiDir>/antigravity/daemon/ls_*.json`. Each is asked
 * for `RetrieveUserQuotaSummary` and `GetUserStatus`, neither of which starts a
 * model turn.
 *
 * This module is read-only by design. It never starts, stops or signs in a
 * seat — `agy-profile.mjs` owns that, and signing in is the user's alone — and
 * it never opens a seat's OAuth token file. A lease or parked entry is read,
 * never swept.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  callEndpoint, NO_SERVER_MESSAGE, parseQuotaSummary, parseUserStatus, QUOTA_PATH, readIde, SIGNED_OUT_MESSAGE, STATUS_PATH,
} from './reading.ts'
import type { AccountStatus, QuotaBucket } from './reading.ts'

/**
 * Relative weekly allowance per tier, the same table the seat router ranks by.
 *
 * `remainingFraction` is relative to each account's own tier, so a plain mean
 * of percentages would let a small account count as much as a large one.
 * Free and Plus are measured equal ("the minimum base limits"); the paid tiers
 * are placeholders until a seat on one is seen. A registry entry's own
 * `weight` overrides the table.
 */
export const TIER_WEIGHTS: Readonly<Record<string, number>> = {
  'free-tier': 1, 'g1-plus-tier': 1, 'g1-pro-tier': 4, 'g1-ultra-tier': 16,
}

/** Seat ids double as directory names in the pool, so they keep that charset. */
const SEAT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/
/** One Connect call on a loopback seat; a healthy seat answers in milliseconds. */
const CALL_TIMEOUT_MS = 4_000
/** Row id and label for the IDE's own server. */
const IDE_ID = 'ide'
const IDE_LABEL = 'Antigravity IDE'

/** What a read found for one account. */
export type SeatState = 'ok' | 'signed-out' | 'down' | 'error'

/** One account row, as published to the panel. Carries no account identifier. */
export interface SeatReading {
  /** Registry seat id, or `ide`. */
  id: string
  /** The registry's label for the seat. */
  label: string
  /** Pool seat or the IDE's own server. */
  source: 'seat' | 'ide'
  state: SeatState
  /** `userTier.id`; empty when unread. */
  tierId: string
  /** The tier's display name; empty when unread. */
  tierName: string
  /** Weight this account carries in the combined figure. */
  weight: number
  /**
   * Whether this account is in the combined figure: it read `ok` and no
   * earlier row is signed in to the same Google account.
   */
  counted: boolean
  /** Router runs currently leased on this seat. */
  inflight: number
  /** Epoch milliseconds the router parked this seat until, or null. */
  parkedUntil: number | null
  /** This account's own buckets. */
  buckets: QuotaBucket[]
}

/** One bucket combined across every counted account. */
export interface CombinedBucket extends QuotaBucket {
  /** Accounts that reported this bucket. */
  accounts: number
}

/** A whole pool read. */
export interface PoolReading {
  /** Tier-weighted buckets across distinct accounts. */
  buckets: CombinedBucket[]
  /** Every account row, counted or not. */
  seats: SeatReading[]
}

/** A seat as the registry records it. */
export interface RegistrySeat {
  id: string
  label: string
  geminiDir: string
  /** Explicit weight, overriding the tier table. */
  weight: number | undefined
}

/** A seat's live server, from its discovery file. */
export interface SeatDiscovery {
  pid: number
  csrfToken: string
  ports: number[]
}

/** @returns the pool root `agy-profile.mjs` uses, honouring its environment override. */
export function defaultPoolRoot(): string {
  return process.env['DSH_ANTIGRAVITY_ROOT'] ?? join(homedir(), '.dsh', 'antigravity')
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/** The registry is hand-editable, and PowerShell 5.1 writes a BOM that `JSON.parse` rejects. */
function readJson(path: string): unknown {
  const body = readFileSync(path, 'utf8')
  return JSON.parse(body.charCodeAt(0) === 0xfeff ? body.slice(1) : body)
}

function portOf(value: unknown): number | undefined {
  const port = typeof value === 'string' && value.trim() ? Number(value) : value
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined
}

/**
 * Read the seat registry, re-read on every refresh so a seat added later appears.
 * @param root - Pool root directory.
 * @returns valid seats in registry order; an absent or broken registry is empty.
 */
export function readRegistry(root: string): RegistrySeat[] {
  let parsed: unknown
  try { parsed = readJson(join(root, 'accounts.json')) } catch { return [] }
  const seats = record(parsed)?.seats
  if (!Array.isArray(seats)) return []
  const ids = new Set<string>()
  const out: RegistrySeat[] = []
  for (const raw of seats) {
    const seat = record(raw)
    const id = seat?.id
    if (typeof id !== 'string' || !SEAT_ID.test(id) || id === IDE_ID || ids.has(id)) continue
    ids.add(id)
    const weight = seat?.weight
    out.push({
      id,
      label: typeof seat?.label === 'string' && seat.label.trim() ? seat.label.trim().slice(0, 80) : id,
      geminiDir: typeof seat?.geminiDir === 'string' && seat.geminiDir ? seat.geminiDir : join(root, 'profiles', id),
      weight: typeof weight === 'number' && Number.isFinite(weight) && weight > 0 ? weight : undefined,
    })
  }
  return out
}

/**
 * Read the newest discovery file a persistent seat wrote on startup.
 *
 * A file can outlive its process, so the caller confirms the pid is alive.
 * @param geminiDir - The seat's Gemini directory.
 * @returns the pid, token and ports, or undefined when there is no usable file.
 */
export function readDiscovery(geminiDir: string): SeatDiscovery | undefined {
  const dir = join(geminiDir, 'antigravity', 'daemon')
  let names: string[]
  try { names = readdirSync(dir) } catch { return undefined }
  let newest: { path: string; mtime: number } | undefined
  for (const name of names) {
    if (!name.startsWith('ls_') || !name.endsWith('.json')) continue
    const path = join(dir, name)
    let mtime: number
    try { mtime = statSync(path).mtimeMs } catch { continue }
    if (!newest || mtime > newest.mtime) newest = { path, mtime }
  }
  if (!newest) return undefined
  let body: Record<string, unknown> | undefined
  try { body = record(readJson(newest.path)) } catch { return undefined }
  const pid = body?.pid
  const csrfToken = body?.csrfToken
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || typeof csrfToken !== 'string' || !csrfToken) return undefined
  const ports = [portOf(body?.httpPort), portOf(body?.httpsPort)].filter((port): port is number => port !== undefined)
  return { pid, csrfToken, ports: [...new Set(ports)] }
}

/** @returns whether a process with this id exists. */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: unknown }).code === 'EPERM'
  }
}

/**
 * Count the router's live leases per seat. Dead-pid leases are ignored, not
 * removed: sweeping them is the router's job.
 * @param root - Pool root directory.
 * @returns seat id to runs in flight.
 */
export function inflightBySeat(root: string): Map<string, number> {
  const counts = new Map<string, number>()
  let names: string[]
  try { names = readdirSync(join(root, 'leases')) } catch { return counts }
  for (const name of names) {
    const match = /^([a-z0-9][a-z0-9_-]*)\.(\d+)\.lease$/.exec(name)
    if (!match?.[1] || !isAlive(Number(match[2]))) continue
    counts.set(match[1], (counts.get(match[1]) ?? 0) + 1)
  }
  return counts
}

/**
 * Read the router's parked seats that are still inside their window.
 * @param root - Pool root directory.
 * @param now - Current epoch milliseconds.
 * @returns seat id to parked-until epoch milliseconds.
 */
export function readParked(root: string, now: number): Map<string, number> {
  const parked = new Map<string, number>()
  let body: Record<string, unknown> | undefined
  try { body = record(readJson(join(root, 'parked.json'))) } catch { return parked }
  for (const [id, entry] of Object.entries(body ?? {})) {
    const until = record(entry)?.until
    const at = typeof until === 'string' ? Date.parse(until) : Number.NaN
    if (Number.isFinite(at) && at > now) parked.set(id, at)
  }
  return parked
}

/**
 * Fold account buckets into one figure per bucket id.
 *
 * Each account contributes its remaining percentage times its tier weight, so
 * the result is the share of the whole pool's allowance still unspent. The
 * reset shown is the soonest one: that is when the pool next gets quota back.
 * @param accounts - Counted accounts with their weights.
 * @returns combined buckets in first-seen order.
 */
export function combine(accounts: readonly { weight: number; buckets: readonly QuotaBucket[] }[]): CombinedBucket[] {
  const totals = new Map<string, { first: QuotaBucket; weight: number; weighted: number; resetsAt: number | null; accounts: number }>()
  for (const account of accounts) {
    if (!(account.weight > 0)) continue
    for (const bucket of account.buckets) {
      const entry = totals.get(bucket.id)
      if (!entry) {
        totals.set(bucket.id, {
          first: bucket, weight: account.weight, weighted: account.weight * bucket.remaining, resetsAt: bucket.resetsAt, accounts: 1,
        })
        continue
      }
      entry.weight += account.weight
      entry.weighted += account.weight * bucket.remaining
      entry.accounts += 1
      if (bucket.resetsAt !== null && (entry.resetsAt === null || bucket.resetsAt < entry.resetsAt)) entry.resetsAt = bucket.resetsAt
    }
  }
  return [...totals.values()].map(entry => ({
    id: entry.first.id,
    group: entry.first.group,
    label: entry.first.label,
    window: entry.first.window,
    remaining: Math.round((entry.weighted / entry.weight) * 10) / 10,
    resetsAt: entry.resetsAt,
    note: null,
    accounts: entry.accounts,
  }))
}

/** A row before de-duplication, still holding the account key. */
type AccountRow = Omit<SeatReading, 'counted' | 'inflight' | 'parkedUntil'> & { account: string | undefined }

/** Read one pool seat. Never throws: every outcome is a row. */
async function readSeat(seat: RegistrySeat, signal: AbortSignal): Promise<AccountRow> {
  const base = { id: seat.id, label: seat.label, source: 'seat' as const, tierId: '', tierName: '', weight: seat.weight ?? 1, buckets: [], account: undefined }
  const discovery = readDiscovery(seat.geminiDir)
  if (!discovery || !isAlive(discovery.pid)) return { ...base, state: 'down' }
  let state: SeatState = 'error'
  // A seat serves plain HTTP on one of its two ports and answers 400 on the
  // other; the discovery file does not say which, so both are tried.
  for (const port of discovery.ports) {
    if (signal.aborted) break
    const endpoint = { host: '127.0.0.1', port, secure: false }
    let buckets: QuotaBucket[]
    try {
      buckets = parseQuotaSummary(await callEndpoint(endpoint, discovery.csrfToken, QUOTA_PATH, CALL_TIMEOUT_MS, signal))
    } catch (error) {
      if (error instanceof Error && error.message === SIGNED_OUT_MESSAGE) state = 'signed-out'
      continue
    }
    let status: AccountStatus = { account: undefined, tierId: '', tierName: '' }
    try { status = parseUserStatus(await callEndpoint(endpoint, discovery.csrfToken, STATUS_PATH, CALL_TIMEOUT_MS, signal)) }
    catch { /* Without the account the seat is still counted, just not de-duplicated. */ }
    return {
      ...base,
      state: 'ok',
      buckets,
      tierId: status.tierId,
      tierName: status.tierName,
      weight: seat.weight ?? TIER_WEIGHTS[status.tierId] ?? 1,
      account: status.account,
    }
  }
  return { ...base, state }
}

/** Options for one pool read. */
export interface PoolOptions {
  /** Pool root directory. */
  root: string
  /** IDE endpoint override; empty discovers. */
  endpoint: string
  /** Also read the IDE's own server. */
  includeIde: boolean
  /** Deadline for the IDE read. Seats carry their own short per-call deadline. */
  timeoutMs: number
  signal: AbortSignal
  /** Current epoch milliseconds, for parked windows. */
  now?: number
}

/**
 * Read the IDE and every registered seat, then combine the distinct accounts.
 * @param options - Where to read and how long to wait.
 * @returns combined buckets and one row per account.
 */
export async function readPool(options: PoolOptions): Promise<PoolReading> {
  const seats = readRegistry(options.root)
  const inflight = inflightBySeat(options.root)
  const parked = readParked(options.root, options.now ?? Date.now())
  const [rows, ide] = await Promise.all([
    Promise.all(seats.map(seat => readSeat(seat, options.signal))),
    options.includeIde ? readIdeRow(options) : Promise.resolve(undefined),
  ])
  if (options.signal.aborted) throw new Error('Antigravity quota read cancelled')
  if (ide) rows.push(ide)
  if (!rows.length) throw new Error('No Antigravity seat or language server found')
  // Seats come first, so when the IDE is signed in to a seat's account it is
  // the IDE row that is marked as the duplicate.
  const seen = new Set<string>()
  const readings: SeatReading[] = rows.map(({ account, ...row }) => {
    const duplicate = account !== undefined && seen.has(account)
    if (account !== undefined) seen.add(account)
    return { ...row, counted: row.state === 'ok' && !duplicate, inflight: inflight.get(row.id) ?? 0, parkedUntil: parked.get(row.id) ?? null }
  })
  return { buckets: combine(readings.filter(row => row.counted)), seats: readings }
}

/** Read the IDE as a row; an IDE that is simply not running produces none. */
async function readIdeRow(options: PoolOptions): Promise<AccountRow | undefined> {
  const base = { id: IDE_ID, label: IDE_LABEL, source: 'ide' as const }
  try {
    const ide = await readIde(options.endpoint, options.timeoutMs, options.signal)
    return { ...base, state: 'ok', tierId: ide.tierId, tierName: ide.tierName, weight: TIER_WEIGHTS[ide.tierId] ?? 1, buckets: ide.buckets, account: ide.account }
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (message === NO_SERVER_MESSAGE || options.signal.aborted) return undefined
    return { ...base, state: message === SIGNED_OUT_MESSAGE ? 'signed-out' : 'error', tierId: '', tierName: '', weight: 1, buckets: [], account: undefined }
  }
}
