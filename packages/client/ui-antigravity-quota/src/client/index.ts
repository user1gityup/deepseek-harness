/** Antigravity remaining quota, immediately above the Claude quota sidebar action. */
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { NS, en, zh, type QuotaKey } from './locales.ts'
import { AntigravityQuota } from './AntigravityQuota.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Antigravity quota copy. */
    'antigravity-quota': QuotaKey
  }
}
/** Required client services. */
export const inject = ['slots', 'locale', 'settingsScope']
/**
 * Bind the host namespace and register the action when its slot is declared.
 * @param ctx - Browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'ui-antigravity-quota: locales')
  const settings = ctx.settingsScope.bind<Record<string, unknown>>({
    namespace: NS,
    decode: value => typeof value === 'object' && value !== null ? value as Record<string, unknown> : {},
  })
  const refresh = async (): Promise<void> => {
    await settings.set('refreshRequestedAt', Math.max(Date.now(), Number(settings.getSnapshot().value?.refreshRequestedAt ?? 0) + 1))
  }
  ctx.slots.inject('sidebar.region.action', () => ctx.slots.register({
    name: 'sidebar.region.action', id: 'antigravity-quota', order: -2, locale: NS,
    inject: () => ({ hooks: { quota: settings }, refresh }),
  }, AntigravityQuota))
}
