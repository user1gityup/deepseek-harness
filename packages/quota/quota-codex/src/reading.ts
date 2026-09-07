/** Read subscription limits through Codex's JSON-RPC app server without a model turn. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** A provider-reported quota window; null fields mean unavailable. */
export interface QuotaWindow {
  /** Percentage remaining, clamped to the displayed range. */
  remaining: number
  /** Window duration in minutes. */
  minutes: number | null
  /** Reset timestamp in Unix seconds. */
  resetsAt: number | null
}
/** Independent metered bucket. */
export interface QuotaBucket {
  /** Provider identifier. */
  id: string
  /** Provider label, or its identifier. */
  label: string
  /** Primary limit window. */
  primary: QuotaWindow | null
  /** Secondary limit window. */
  secondary: QuotaWindow | null
}
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
function window(value: unknown): QuotaWindow | null {
  const row = record(value)
  if (!row || !finite(row.usedPercent)) return null
  return {
    remaining: Math.max(0, Math.min(100, 100 - row.usedPercent)),
    minutes: finite(row.windowDurationMins) && row.windowDurationMins > 0 ? row.windowDurationMins : null,
    resetsAt: finite(row.resetsAt) && row.resetsAt > 0 && row.resetsAt < 8.64e12 ? row.resetsAt : null,
  }
}
/**
 * Normalize a rateLimits/read result, preferring its multi-bucket view.
 * @param value - Untrusted JSON-RPC result.
 * @returns Valid buckets, including unknown windows without inventing zero usage.
 */
export function parseLimits(value: unknown): QuotaBucket[] {
  const result = record(value)
  if (!result) throw new Error('Invalid Codex limits response')
  const mapped = record(result.rateLimitsByLimitId)
  const legacy = record(result.rateLimits)
  const entries = mapped && Object.keys(mapped).length > 0
    ? Object.entries(mapped)
    : legacy ? [[typeof legacy.limitId === 'string' ? legacy.limitId : 'codex', legacy] as const] : []
  return entries.flatMap(([id, raw]) => {
    const bucket = record(raw)
    if (!bucket) return []
    return [{ id, label: typeof bucket.limitName === 'string' && bucket.limitName ? bucket.limitName : id,
      primary: window(bucket.primary), secondary: window(bucket.secondary) }]
  }).sort((a, b) => a.id === 'codex' ? -1 : b.id === 'codex' ? 1 : a.id.localeCompare(b.id))
}
/** Resolve an executable without invoking a command shell or an npm cmd shim. */
export function codexBinary(): string {
  const binary = process.platform === 'win32' ? 'codex.exe' : 'codex'
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const path = join(directory, binary)
    if (existsSync(path)) return path
  }
  if (process.platform === 'win32') {
    const path = join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@openai', 'codex',
      'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', binary)
    if (existsSync(path)) return path
  }
  return binary
}
/**
 * Start a short-lived app server and read account limits using its existing login.
 * @param executable - Codex binary path or executable name.
 * @param timeoutMs - Hard deadline for this read.
 * @param signal - Plugin disposal cancels and awaits child exit.
 * @returns Provider limits after the child has exited; throws a credential-free error on failure.
 */
export function readQuota(executable: string, timeoutMs: number, signal: AbortSignal): Promise<QuotaBucket[]> {
  if (signal.aborted) return Promise.reject(new Error('Codex quota read cancelled'))
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key)))
    const child = spawn(executable, ['app-server'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    let buffer = ''
    let bytes = 0
    let result: QuotaBucket[] | undefined
    let failure: Error | undefined
    let initialized = false
    const stop = (error?: Error): void => {
      failure ??= error
      child.stdin.end()
      child.kill()
    }
    const abort = (): void => { stop(new Error('Codex quota read cancelled')) }
    const timer = setTimeout(() => { stop(new Error('Codex quota read timed out')) }, timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    const send = (message: unknown): void => { child.stdin.write(JSON.stringify(message) + '\n') }
    child.stdin.on('error', () => { stop(new Error('Codex quota connection closed')) })
    child.on('error', () => { failure = new Error('Unable to start Codex; check the executable setting') })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > 1024 * 1024) { stop(new Error('Codex quota response exceeded 1 MiB')); return }
      buffer += chunk
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (!line.trim()) continue
        let message: Record<string, unknown> | undefined
        try { message = record(JSON.parse(line)) } catch { stop(new Error('Invalid Codex JSON-RPC response')); return }
        if (message?.id !== 1 && message?.id !== 2) continue
        if (message.error) { stop(new Error('Codex quota unavailable; check your ChatGPT login')); return }
        if (message.id === 1 && !initialized) {
          initialized = true
          send({ method: 'initialized' })
          send({ id: 2, method: 'account/rateLimits/read' })
        } else if (message.id === 2 && initialized) {
          try { result = parseLimits(message.result) } catch { stop(new Error('Invalid Codex limits response')); return }
          stop()
          return
        }
      }
    })
    child.on('close', () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (result) resolve(result)
      else reject(new Error('Codex exited before returning quota'))
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'dsh_codex_quota', version: '0.1.0' } } })
  })
}
