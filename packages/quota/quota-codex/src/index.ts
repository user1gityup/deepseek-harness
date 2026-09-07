/** Publish Codex subscription allowance to the browser settings mirror. */
import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { codexBinary, readQuota } from './reading.ts'

/** Cordis plugin identifier. */
export const name = 'quota-codex'
/** Required settings provider. */
export const inject = ['settings']
/** Namespace mirrored by the sidebar panel. */
export const CODEX_QUOTA_NAMESPACE = settingsNamespace('codex-quota')
/** Flat settings avoid nested Schemastery defaults. */
export interface Config {
  /** Register and refresh when enabled. */
  enabled?: boolean
  /** Executable override; empty resolves Codex on PATH. */
  executable?: string
  /** Poll period in milliseconds; zero disables automatic polling after boot. */
  refreshIntervalMs?: number
  /** Deadline for a single read in milliseconds. */
  timeoutMs?: number
  /** Serialized normalized quota buckets, without account identifiers or credentials. */
  bucketsJson?: string
  /** Last successful capture in epoch milliseconds. */
  capturedAt?: number
  /** Monotonic refresh request from the panel. */
  refreshRequestedAt?: number
  /** idle, running, ok, or failed. */
  refreshState?: string
}
/** Loader configuration and published state. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true), executable: z.string().default(''),
  refreshIntervalMs: z.natural().default(300_000), timeoutMs: z.number().min(1000).default(20_000),
  bucketsJson: z.string().default('[]'), capturedAt: z.number().default(0),
  refreshRequestedAt: z.number().default(0), refreshState: z.string().default('idle'),
})
/**
 * Register the publisher, serial refreshes, and cancellation on unload.
 * @param ctx - Host context with settings.
 * @param config - Resolved plugin settings.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.enabled === false) return
  const scope = ctx.settings.register(
    CODEX_QUOTA_NAMESPACE,
    Config as never,
    { base: config as never },
  ) as SettingsScope<Config> | undefined
  if (!scope) return
  ctx.effect(() => {
    const controller = new AbortController()
    let pending: Promise<void> | undefined
    const run = (): void => {
      if (pending || controller.signal.aborted) return
      pending = (async () => {
        try {
          await ctx.settings.update(CODEX_QUOTA_NAMESPACE, { refreshState: 'running' })
          const buckets = await readQuota(config.executable || codexBinary(), config.timeoutMs ?? 20_000, controller.signal)
          if (!controller.signal.aborted) await ctx.settings.update(CODEX_QUOTA_NAMESPACE, {
            bucketsJson: JSON.stringify(buckets), capturedAt: Date.now(), refreshState: 'ok',
          })
        } catch {
          // Read failures retain the last capture; no child output enters browser settings.
          if (!controller.signal.aborted) {
            try { await ctx.settings.update(CODEX_QUOTA_NAMESPACE, { refreshState: 'failed' }) }
            catch { /* A read-only or disposed settings provider cannot publish status. */ }
          }
        }
      })().finally(() => { pending = undefined })
    }
    const unwatch = scope.watch((next, prev) => {
      if ((next.refreshRequestedAt ?? 0) > (prev.refreshRequestedAt ?? 0)) run()
    })
    const interval = config.refreshIntervalMs ?? 300_000
    const timer = interval > 0 ? setInterval(run, interval) : undefined
    run()
    return async () => {
      unwatch()
      if (timer) clearInterval(timer)
      controller.abort()
      await pending
    }
  }, 'quota-codex: reader lifecycle')
}
