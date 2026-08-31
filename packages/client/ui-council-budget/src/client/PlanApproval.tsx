/**
 * The council's spending gate, as a control only a person can operate.
 *
 * The council used to treat a `plan` argument as proof of approval. The model
 * is the caller, so it wrote its own plan and spent money nobody agreed to.
 * This bar is the trigger half of the replacement: pressing it writes the
 * issued plan's id into settings, a channel no model-facing tool can reach.
 *
 * It is deliberately the full width of the composer and sits above it. An
 * approval control that has to be hunted for is one people click without
 * reading.
 */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { useSyncExternalStore } from 'react'
import type { SettingsFace } from './CouncilBudget.tsx'
import { NS } from './locales.ts'
import css from './PlanApproval.module.css'

/** Must match the host's PLAN_TTL_MS: an expired plan is not approvable. */
const PLAN_TTL_MS = 15 * 60 * 1000

/** Props for the approval bar. */
export type PlanApprovalProps =
  PropsRuntime<'conversation.input.dock'>
  & PropsLocale<typeof NS>
  & { settings: SettingsFace }

/** The pending plan as stored by the host. */
interface Pending {
  readonly id: string
  readonly query: string
  readonly issuedAt: number
}

/**
 * Read the pending plan out of the settings section.
 *
 * Stored as flat scalars rather than a nested object: the settings schema
 * materialises a default into a nested object, which then fails its own
 * required-field validation at load and stops the host booting.
 * @param section - the decoded council settings.
 * @returns the pending plan, or undefined when none is held.
 */
function readPending(section: Record<string, unknown> | undefined): Pending | undefined {
  const id = section?.['pendingPlanId']
  if (typeof id !== 'string' || id === '') return undefined
  const query = section?.['pendingPlanQuery']
  const issuedAt = section?.['pendingPlanIssuedAt']
  return {
    id,
    query: typeof query === 'string' ? query : '',
    issuedAt: typeof issuedAt === 'number' ? issuedAt : 0,
  }
}

/**
 * Approval bar shown while the council holds a plan at the gate.
 * @param props - locale seat and the council settings scope.
 * @returns the bar, or null when there is nothing awaiting approval.
 */
export function PlanApproval({ t, settings }: PlanApprovalProps): JSX.Element | null {
  const snapshot = useSyncExternalStore(
    fn => settings.subscribe(fn),
    () => settings.getSnapshot(),
  )
  const section = snapshot.value
  const auto = section?.['autoApprove'] === true

  // A disabled failsafe has to be visible, or people forget it is off and are
  // surprised by what gets spent. This bar persists while auto-approve is on.
  if (auto) {
    return (
      <div className={`${css.bar} ${css.auto}`} role="status">
        <span className={css.mark} aria-hidden="true">⚡</span>
        <span className={css.text}>{t('approve.autoOn')}</span>
        <button
          type="button"
          className={css.discard}
          onClick={() => { void settings.set('autoApprove', false) }}
        >
          {t('approve.autoOff')}
        </button>
      </div>
    )
  }

  const pending = readPending(section)
  if (pending === undefined) return null
  // The gate's state is global, so a plan from a conversation the user has
  // left would otherwise keep offering to spend money here.
  if (Date.now() - pending.issuedAt > PLAN_TTL_MS) return null

  const approvedId = section?.['approvedPlanId']
  const approved = approvedId === pending.id

  // Approved but not yet run: the verbal half is outstanding, so say so
  // instead of leaving a pressed button that appears to have done nothing.
  if (approved) {
    return (
      <div className={`${css.bar} ${css.waiting}`} role="status">
        <span className={css.mark} aria-hidden="true">✓</span>
        <span className={css.text}>{t('approve.awaitingMessage')}</span>
      </div>
    )
  }

  const preview = pending.query.length > 90 ? `${pending.query.slice(0, 90)}…` : pending.query

  return (
    <div className={css.bar} role="group" aria-label={t('approve.title')}>
      <span className={css.mark} aria-hidden="true">⏸</span>
      <span className={css.text}>
        <strong className={css.title}>{t('approve.title')}</strong>
        {preview === '' ? null : <span className={css.query}>{preview}</span>}
      </span>
      <button
        type="button"
        className={css.approve}
        onClick={() => {
          // Order matters: the id identifies WHICH plan was approved, and the
          // timestamp is what the verbal factor is measured against.
          void settings.set('approvedPlanId', pending.id)
          void settings.set('approvedAt', Date.now())
        }}
      >
        {t('approve.action')}
      </button>
      <button
        type="button"
        className={css.discard}
        onClick={() => { void settings.set('pendingPlanId', '') }}
      >
        {t('approve.discard')}
      </button>
      <label className={css.always} title={t('approve.alwaysHint')}>
        <input
          type="checkbox"
          checked={false}
          onChange={() => {
            // Turning this on approves the plan in hand as well, so the click
            // that grants standing permission also releases the run waiting
            // on it — otherwise it looks like nothing happened.
            void settings.set('approvedPlanId', pending.id)
            void settings.set('approvedAt', Date.now())
            void settings.set('autoApprove', true)
          }}
        />
        <span>{t('approve.always')}</span>
      </label>
    </div>
  )
}
