/** Publish Antigravity subscription allowance to the browser settings mirror. */
import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { readQuota } from './reading.ts'

/** Cordis plugin identifier. */
export const name = 'quota-antigravity'
/** Required settings provider. */
export const inject = ['settings']
/** Namespace mirrored by the sidebar panel. */
export const ANTIGRAVITY_QUOTA_NAMESPACE = settingsNamespace('antigravity-quota')
/** Flat settings avoid nested Schemastery defaults. */
export interface Config {
  /** Register and refresh when enabled. */
  enabled?: boolean
  /** Loopback endpoint override; empty discovers the running language server. */
  endpoint?: string
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
  enabled: z.boolean().default(true), endpoint: z.string().default(''),
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
    ANTIGRAVITY_QUOTA_NAMESPACE,
    Config as never,
    { base: config as never },
  ) as SettingsScope<Config> | undefined
  if (!scope) return
  ctx.effect(() => {
    const controller = new AbortController()
    let pending: Promise<void> | undefined
    /**
     * A refresh asked for while a read is in flight, to be served once it ends.
     *
     * Dropping it instead is what a plain `if (pending) return` does, and from
     * the panel that reads as a dead button: the boot read is still settling
     * when the user's first click lands, the click is discarded, and nothing
     * about the display changes to say so. Reads stay serial either way — this
     * only decides whether the request is remembered or thrown away.
     */
    let queued = false
    const run = (): void => {
      if (controller.signal.aborted) return
      if (pending) {
        queued = true
        return
      }
      pending = (async () => {
        try {
          await ctx.settings.update(ANTIGRAVITY_QUOTA_NAMESPACE, { refreshState: 'running' })
          const buckets = await readQuota(config.endpoint ?? '', config.timeoutMs ?? 20_000, controller.signal)
          if (!controller.signal.aborted) await ctx.settings.update(ANTIGRAVITY_QUOTA_NAMESPACE, {
            bucketsJson: JSON.stringify(buckets), capturedAt: Date.now(), refreshState: 'ok',
          })
        } catch {
          // Read failures retain the last capture; no child output enters browser settings.
          if (!controller.signal.aborted) {
            try { await ctx.settings.update(ANTIGRAVITY_QUOTA_NAMESPACE, { refreshState: 'failed' }) }
            catch { /* A read-only or disposed settings provider cannot publish status. */ }
          }
        }
      })().finally(() => {
        pending = undefined
        if (queued && !controller.signal.aborted) {
          queued = false
          run()
        }
      })
    }
    // The panel requests a refresh by bumping `refreshRequestedAt`, and the
    // rising edge is tracked here rather than read off the two snapshots the
    // watcher is handed. `prev` is only reliable once the scope has quiesced:
    // measured, the same update is delivered as `{ next: 1, prev: 0 }` when
    // nothing else is in flight, but as `{ next: 1, prev: 1 }` when it lands
    // among the updates a running read is already publishing — distinct
    // objects, both carrying the committed value, so `next > prev` is false
    // and the click is lost. Which of the two happens is a race, which is the
    // worst shape for a button to fail in. Remembering the last value acted on
    // does not depend on when the scope commits, and it also collapses repeat
    // deliveries of one edge into a single read.
    let refreshedAt = config.refreshRequestedAt ?? 0
    const unwatch = scope.watch((next) => {
      const requested = next.refreshRequestedAt ?? 0
      if (requested <= refreshedAt) return
      refreshedAt = requested
      run()
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
  }, 'quota-antigravity: reader lifecycle')
}
