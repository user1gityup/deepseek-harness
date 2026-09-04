/**
 * The pipeline control: one button for the whole council → swarm → council run.
 *
 * The chain is a tool, and a tool is only reachable by asking the model for it.
 * That is the thing this control removes: the user should not have to remember
 * the wording that starts a three-stage run, nor retype it to continue one. So
 * the prompt lives here, in the open, and the button sends it.
 *
 * It is deliberately NOT a hidden instruction. What gets sent is shown on the
 * control before it is sent, because a button that silently prompts on the
 * user's behalf is a button they cannot audit.
 *
 * The held state is the reason this is a panel rather than a single button.
 * A run parked on a spent subscription has to come back by itself — that is
 * the whole point of holding rather than failing — so the control counts the
 * hold down and sends the continue prompt once, on its own, when the window
 * has rolled over.
 */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { SettingsFace } from './CouncilBudget.tsx'
import { NS } from './locales.ts'
import css from './PipelineControl.module.css'

/** Props for the pipeline control. */
export type PipelineControlProps =
  PropsRuntime<'conversation.input.dock'>
  & PropsLocale<typeof NS>
  & {
    settings: SettingsFace
    /** Sends one prompt into this session, exactly as typed. */
    send: (text: string) => Promise<void>
  }

/** Stage order, mirrored from the host so the control can count them. */
const STAGES = ['council', 'swarm', 'review'] as const

/** What each stage is called on the control. */
const STAGE_LABEL: Record<string, string> = {
  council: 'council — agree the approach',
  swarm: 'swarm — split and run the work',
  review: 'council — review what came back',
}

/**
 * The prompt that starts a run, shown to the user before it is sent.
 * @param request - the work, in the user's own words.
 * @returns the prompt text.
 */
export function startPrompt(request: string): string {
  return `Run the pipeline tool on this request, one stage at a time: ${request}`
}

/** The prompt that advances a run that is already in progress. */
export const CONTINUE_PROMPT = 'Continue the pipeline — call the pipeline tool again to advance the next stage.'

/**
 * How long until a hold ends, worded for a person.
 * @param resumeAt - epoch ms.
 * @param now - epoch ms.
 * @returns e.g. "12m 04s".
 */
function countdown(resumeAt: number, now: number): string {
  const left = Math.max(0, resumeAt - now)
  const minutes = Math.floor(left / 60_000)
  const seconds = Math.floor((left % 60_000) / 1_000)
  return `${String(minutes)}m ${seconds < 10 ? '0' : ''}${String(seconds)}s`
}

/**
 * Pipeline control, docked above the composer.
 * @param props - locale seat, the council settings scope, and the send face.
 * @returns the control.
 */
export function PipelineControl({ t, settings, send }: PipelineControlProps): JSX.Element | null {
  const snapshot = useSyncExternalStore(
    fn => settings.subscribe(fn),
    () => settings.getSnapshot(),
  )
  const section = snapshot.value
  const [request, setRequest] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  // A hold must reactivate ONCE. Without this the countdown reaching zero
  // would send the continue prompt on every tick.
  const fired = useRef<number>(0)

  const running = typeof section?.['pipelineId'] === 'string' && section['pipelineId'] !== ''
  const stage = typeof section?.['pipelineStage'] === 'string' ? section['pipelineStage'] : 'council'
  const resumeAt = typeof section?.['pipelineHoldResumeAt'] === 'number' ? section['pipelineHoldResumeAt'] : 0
  const held = resumeAt > 0
  const query = typeof section?.['pipelineQuery'] === 'string' ? section['pipelineQuery'] : ''

  // The clock only runs while something is actually counting down.
  useEffect(() => {
    if (!held) return undefined
    const timer = setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { clearInterval(timer) }
  }, [held])

  const go = (text: string): void => {
    setBusy(true)
    void send(text).finally(() => { setBusy(false) })
  }

  // The reactivation itself: the window has rolled over, so continue without
  // being asked. This is what the hold exists for.
  useEffect(() => {
    if (!held || now < resumeAt || fired.current === resumeAt) return
    fired.current = resumeAt
    go(CONTINUE_PROMPT)
  }, [held, now, resumeAt])

  const index = STAGES.indexOf(stage as (typeof STAGES)[number])
  const position = index < 0 ? 1 : index + 1

  return (
    <div className={css.panel} role="group" aria-label={t('pipeline.title')}>
      <div className={css.head}>
        <strong className={css.title}>{t('pipeline.title')}</strong>
        <span className={css.sub}>{t('pipeline.hint')}</span>
      </div>

      {held
        ? (
          <div className={css.held}>
            <span className={css.lamp} aria-hidden="true" />
            <span>
              {t('pipeline.held')}
              {' '}
              <strong>{countdown(resumeAt, now)}</strong>
              {' · '}
              {STAGE_LABEL[stage] ?? stage}
            </span>
            <button
              type="button"
              className={css.action}
              disabled={busy}
              onClick={() => { go(CONTINUE_PROMPT) }}
            >
              {t('pipeline.resumeNow')}
            </button>
          </div>
        )
        : null}

      {running && !held
        ? (
          <div className={css.row}>
            <span className={css.stage}>
              {`Stage ${String(position)} of 3 · ${STAGE_LABEL[stage] ?? stage}`}
            </span>
            <button
              type="button"
              className={css.action}
              disabled={busy}
              onClick={() => { go(CONTINUE_PROMPT) }}
            >
              {t('pipeline.continue')}
            </button>
            <span className={css.query} title={query}>{query}</span>
          </div>
        )
        : null}

      {!running
        ? (
          <div className={css.row}>
            <input
              className={css.input}
              type="text"
              value={request}
              placeholder={t('pipeline.placeholder')}
              onChange={(event) => { setRequest(event.target.value) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && request.trim() !== '') go(startPrompt(request.trim()))
              }}
            />
            <button
              type="button"
              className={css.action}
              disabled={busy || request.trim() === ''}
              onClick={() => { go(startPrompt(request.trim())) }}
            >
              {t('pipeline.run')}
            </button>
          </div>
        )
        : null}

      {/* The prompt is shown, not hidden: a button that speaks for the user
          should say what it is about to say. */}
      {!running && request.trim() !== ''
        ? <p className={css.preview}>{startPrompt(request.trim())}</p>
        : null}
    </div>
  )
}
