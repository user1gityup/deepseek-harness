/**
 * Swarm roster: who does what, and what it costs to have them do it.
 *
 * The panel exists because the assignment policy has a strong default —
 * subscription workers carry the code — and a default that cannot be seen or
 * overridden is just a hidden decision. Every worker shows how it bills, so
 * the cost consequence of switching one on is visible at the moment of
 * switching it on rather than afterwards on a bill.
 */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { useSyncExternalStore } from 'react'
import type { SettingsFace } from './CouncilBudget.tsx'
import { NS } from './locales.ts'
import css from './SwarmRoster.module.css'

/** Props for the roster panel. */
export type SwarmRosterProps =
  PropsRuntime<'conversation.input.dock'>
  & PropsLocale<typeof NS>
  & { settings: SettingsFace }

/** Kinds of work a worker can be assigned. */
const KINDS = ['code', 'tests', 'docs', 'research', 'review'] as const

/** One worker as the panel understands it. */
interface RosterWorker {
  readonly provider: string
  readonly name: string
  readonly subscription: boolean
  readonly enabled: boolean
  readonly kinds: readonly string[]
}

/**
 * Workers the host knows about, merged with the user's overrides.
 *
 * The shipped defaults put the subscription seats on and the metered one off.
 * A provider absent from this host is not offered at all, so the panel never
 * shows a worker that cannot run.
 * @param section - decoded council settings.
 * @returns the roster to render.
 */
function readRoster(section: Record<string, unknown> | undefined): readonly RosterWorker[] {
  const overrides = (section?.['swarmRoster'] ?? {}) as Record<string, {
    enabled?: boolean
    kinds?: string[]
  }>
  const shipped: readonly Omit<RosterWorker, 'enabled' | 'kinds'>[] = [
    { provider: 'claude-code', name: 'Claude', subscription: true },
    { provider: 'codex', name: 'OpenAI', subscription: true },
    { provider: 'spawn', name: 'In-process', subscription: false },
  ]
  const defaults: Record<string, { enabled: boolean; kinds: string[] }> = {
    'claude-code': { enabled: true, kinds: ['code', 'tests', 'review'] },
    'codex': { enabled: true, kinds: ['code', 'tests'] },
    'spawn': { enabled: false, kinds: [] },
  }
  return shipped.map((worker) => {
    const override = overrides[worker.provider]
    const fallback = defaults[worker.provider] ?? { enabled: false, kinds: [] }
    return {
      ...worker,
      enabled: override?.enabled ?? fallback.enabled,
      kinds: override?.kinds ?? fallback.kinds,
    }
  })
}

/**
 * Roster panel, shown while swarm mode is on.
 * @param props - locale seat and the council settings scope.
 * @returns the panel, or null when swarm mode is off.
 */
export function SwarmRoster({ t, settings }: SwarmRosterProps): JSX.Element | null {
  const snapshot = useSyncExternalStore(
    fn => settings.subscribe(fn),
    () => settings.getSnapshot(),
  )
  const section = snapshot.value
  if (section?.['swarmMode'] !== true) return null

  const roster = readRoster(section)
  const overrides = { ...(section['swarmRoster'] ?? {}) } as Record<string, {
    enabled?: boolean
    kinds?: string[]
  }>

  /** Write one worker's override back, leaving the others untouched. */
  const write = (provider: string, patch: { enabled?: boolean; kinds?: string[] }): void => {
    const current = overrides[provider] ?? {}
    void settings.set('swarmRoster', { ...overrides, [provider]: { ...current, ...patch } })
  }

  const active = roster.filter(worker => worker.enabled)
  const meteredOn = active.some(worker => !worker.subscription)

  return (
    <div className={css.panel} role="group" aria-label={t('swarm.title')}>
      <div className={css.head}>
        <strong className={css.title}>{t('swarm.title')}</strong>
        <span className={css.sub}>{t('swarm.hint')}</span>
      </div>

      {roster.map(worker => (
        <div key={worker.provider} className={worker.enabled ? css.row : `${css.row} ${css.off}`}>
          <label className={css.name}>
            <input
              type="checkbox"
              checked={worker.enabled}
              onChange={() => { write(worker.provider, { enabled: !worker.enabled }) }}
            />
            <span>{worker.name}</span>
            <span className={worker.subscription ? css.free : css.metered}>
              {worker.subscription ? t('swarm.subscription') : t('swarm.metered')}
            </span>
          </label>
          <div className={css.kinds}>
            {KINDS.map((kind) => {
              const on = worker.kinds.includes(kind)
              return (
                <button
                  key={kind}
                  type="button"
                  className={on ? `${css.kind} ${css.kindOn}` : css.kind}
                  aria-pressed={on}
                  disabled={!worker.enabled}
                  onClick={() => {
                    const next = on
                      ? worker.kinds.filter(entry => entry !== kind)
                      : [...worker.kinds, kind]
                    write(worker.provider, { kinds: next })
                  }}
                >
                  {kind}
                </button>
              )
            })}
          </div>
        </div>
      ))}

      {active.length === 0
        ? <p className={css.warn}>{t('swarm.noneEnabled')}</p>
        : null}
      {meteredOn
        ? <p className={css.warn}>{t('swarm.meteredWarning')}</p>
        : null}
    </div>
  )
}
