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

/** What this view could read off a settled call. */
interface CallContent {
  /** Report text with the marker removed. */
  readonly report: string
  /** Plan this call issued, when it issued one. */
  readonly planId?: string | undefined
}

/** Marker the host appends so a call can name the plan it issued. */
const PLAN_MARKER = /<!--council-plan:([0-9a-f-]{16,})-->/i

/**
 * Read the council's report and plan id off a settled call.
 *
 * A tool result node carries rendered `content` blocks and a closed union of
 * card shapes — there is no structured payload — so the plan id travels as a
 * marker inside the text and is stripped here before display.
 * @param block - the running or settled call node.
 * @returns the report and plan id, or undefined while there is no content.
 */
function readCall(block: unknown): CallContent | undefined {
  if (typeof block !== 'object' || block === null) return undefined
  const content = (block as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  const text = content
    .map((entry) => {
      if (typeof entry !== 'object' || entry === null) return ''
      const row = entry as { type?: unknown; text?: unknown }
      return row.type === 'text' && typeof row.text === 'string' ? row.text : ''
    })
    .filter(part => part !== '')
    .join(String.fromCharCode(10))
  if (text === '') return undefined
  const found = PLAN_MARKER.exec(text)
  const report = text.replace(PLAN_MARKER, '').trimEnd()
  return found === null ? { report } : { report, planId: found[1] }
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
  const parsed = readCall(block)
  if (parsed === undefined) return null
  const report = parsed.report

  const section = snapshot.value
  const callPlanId = parsed.planId
  const heldId = section?.['pendingPlanId']
  const approvedId = section?.['approvedPlanId']
  const autoApprove = section?.['autoApprove'] === true

  // Only the call whose plan is still the held one may be approved. An older
  // call keeps its report but says plainly that its plan has been replaced.
  const hasHeld = typeof heldId === 'string' && heldId !== ''
  const isHeld = callPlanId !== undefined && callPlanId !== '' && heldId === callPlanId
  const isApproved = isHeld && approvedId === callPlanId
  // Superseded means a DIFFERENT plan is held. No plan held at all is a
  // different fault entirely — the write never landed — and calling that
  // "superseded" would send the reader hunting for a newer plan that does
  // not exist.
  const isSuperseded = callPlanId !== undefined && callPlanId !== '' && hasHeld && !isHeld
  const isUnrecorded = callPlanId !== undefined && callPlanId !== '' && !hasHeld

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

      {isUnrecorded
        ? <p className={css.note}>{t_('unrecorded')}</p>
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
function t_(key: 'needsApproval' | 'approve' | 'discard' | 'approvedSendMessage' | 'superseded' | 'unrecorded' | 'auto'): string {
  const strings: Record<string, string> = {
    needsApproval: 'This plan needs your approval before the council spends anything.',
    approve: 'Approve',
    discard: 'Discard',
    approvedSendMessage: 'Approved. Send any message to run the council on this plan.',
    superseded: 'This plan has been replaced by a newer one and can no longer be approved.',
    unrecorded: 'This plan was never recorded, so it cannot be approved. The council could not write to settings — the report above says why.',
    auto: 'Auto-approve is on, so this plan did not wait.',
  }
  return strings[key] ?? key
}

export { NS }
