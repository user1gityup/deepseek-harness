/**
 * The council's own result view: its report, and the Approve control that
 * belongs to it.
 *
 * The approval control used to float above the composer, detached from the
 * plan it approved. That was wrong in two ways people actually hit: a plan
 * message scrolled up in history looked identical whether or not it was still
 * approvable, and once a plan expired the control vanished with no explanation
 * of which message it had belonged to.
 *
 * Attaching it to the call that issued the plan removes the ambiguity. The
 * button is on the thing it approves. A superseded plan says so, in place,
 * instead of silently losing its button.
 *
 * Owning the view also means the report is rendered from the tool result
 * itself rather than from the model's retelling of it — so a model that
 * summarises and drops the losing seats cannot hide them from the reader.
 */

import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { useSyncExternalStore } from 'react'
import type { SettingsFace } from './CouncilBudget.tsx'
import { NS } from './locales.ts'
import css from './CouncilCallView.module.css'

/** Props for the council tool view. */
export type CouncilCallViewProps = ToolCallViewProps & { settings: SettingsFace }

/** Result fields this view reads off the settled call. */
interface CouncilValue {
  readonly report?: unknown
  readonly phase?: unknown
  readonly planId?: unknown
  readonly query?: unknown
}

/**
 * Pull the council's result value off a settled tool call.
 *
 * Tolerant by design: a running call has no value yet, and a shape that has
 * moved on should degrade to "no report" rather than throw inside a renderer.
 * @param block - the running or settled call node.
 * @returns the result value, or undefined while it has none.
 */
function readValue(block: unknown): CouncilValue | undefined {
  if (typeof block !== 'object' || block === null) return undefined
  const row = block as Record<string, unknown>
  const candidates = [row['value'], row['result'], row['output']]
  for (const candidate of candidates) {
    if (typeof candidate === 'object' && candidate !== null) return candidate as CouncilValue
  }
  return undefined
}

/**
 * Council tool view: the report, plus approval when this call's plan is live.
 * @param props - the settled call and the council settings scope.
 * @returns the rendered call.
 */
export function CouncilCallView({ block, settings }: CouncilCallViewProps): JSX.Element | null {
  const snapshot = useSyncExternalStore(
    fn => settings.subscribe(fn),
    () => settings.getSnapshot(),
  )
  const value = readValue(block)
  const report = typeof value?.report === 'string' ? value.report : ''
  if (report === '') return null

  const section = snapshot.value
  const callPlanId = typeof value?.planId === 'string' ? value.planId : undefined
  const heldId = section?.['pendingPlanId']
  const approvedId = section?.['approvedPlanId']
  const autoApprove = section?.['autoApprove'] === true

  // Only the call whose plan is still the held one may be approved. An older
  // call keeps its report but says plainly that its plan has been replaced.
  const isHeld = callPlanId !== undefined && callPlanId !== '' && heldId === callPlanId
  const isApproved = isHeld && approvedId === callPlanId
  const isSuperseded = callPlanId !== undefined && callPlanId !== '' && !isHeld

  return (
    <div className={css.view}>
      <pre className={css.report}>{report}</pre>

      {autoApprove && isHeld
        ? <p className={css.note}>{t_('auto')}</p>
        : null}

      {!autoApprove && isHeld && !isApproved
        ? (
          <div className={css.gate}>
            <span className={css.gateText}>{t_('needsApproval')}</span>
            <button
              type="button"
              className={css.approve}
              onClick={() => {
                // Order matters: the id says WHICH plan was approved, and the
                // timestamp is what the second factor is measured against.
                void settings.set('approvedPlanId', callPlanId)
                void settings.set('approvedAt', Date.now())
              }}
            >
              {t_('approve')}
            </button>
            <button
              type="button"
              className={css.discard}
              onClick={() => { void settings.set('pendingPlanId', '') }}
            >
              {t_('discard')}
            </button>
          </div>
        )
        : null}

      {!autoApprove && isApproved
        ? <p className={css.approved}>{t_('approvedSendMessage')}</p>
        : null}

      {isSuperseded
        ? <p className={css.note}>{t_('superseded')}</p>
        : null}
    </div>
  )
}

/**
 * Local copy for this view.
 *
 * The tool-view slot supplies no locale seat, so the strings live here rather
 * than reaching for a `t` that is not passed in.
 * @param key - which string.
 * @returns the English text.
 */
function t_(key: 'needsApproval' | 'approve' | 'discard' | 'approvedSendMessage' | 'superseded' | 'auto'): string {
  const strings: Record<string, string> = {
    needsApproval: 'This plan needs your approval before the council spends anything.',
    approve: 'Approve',
    discard: 'Discard',
    approvedSendMessage: 'Approved. Send any message to run the council on this plan.',
    superseded: 'This plan has been replaced by a newer one and can no longer be approved.',
    auto: 'Auto-approve is on, so this plan did not wait.',
  }
  return strings[key] ?? key
}

export { NS }
