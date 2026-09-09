/** Remaining quota projection; settings are supplied by the host reader. */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { NS } from './locales.ts'
import css from './AntigravityQuota.module.css'

interface Bucket { id: string; group: string; label: string; remaining: number; resetsAt: number | null }
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
function buckets(value: unknown): Bucket[] {
  if (typeof value !== 'string') return []
  let rows: unknown
  try { rows = JSON.parse(value) } catch { return [] }
  if (!Array.isArray(rows)) return []
  return rows.filter((row: unknown): row is Bucket => object(row) && typeof row.id === 'string'
    && typeof row.label === 'string' && typeof row.group === 'string'
    && typeof row.remaining === 'number' && Number.isFinite(row.remaining) && row.remaining >= 0 && row.remaining <= 100
    && (row.resetsAt === null || (typeof row.resetsAt === 'number' && Number.isFinite(row.resetsAt) && row.resetsAt > 0 && row.resetsAt < 8.64e12)))
}
/** Sidebar runtime, locale, and settings inputs. */
export type AntigravityQuotaProps = PropsRuntime<'sidebar.region.action'> & PropsLocale<typeof NS>
  & InjectFace<{ hooks: { quota: SettingsScope<Record<string, unknown>> }; refresh: () => Promise<void> }>
/**
 * Render remaining percentages and reset timestamps with manual refresh.
 * @param props - Sidebar runtime and synchronized settings.
 * @returns Sidebar action and its expandable quota panel.
 */
export function AntigravityQuota({ wide, t, useQuota, refresh }: AntigravityQuotaProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [bottom, setBottom] = useState(0)
  const [writeFailed, setWriteFailed] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const snapshot = useQuota(value => value)
  const section = snapshot.value
  const rows = buckets(section?.bucketsJson)
  const summary = rows[0]
  const running = section?.refreshState === 'running'
  const captured = typeof section?.capturedAt === 'number' && section.capturedAt > 0 ? section.capturedAt : undefined
  useEffect(() => {
    if (!open) return
    const place = (): void => { setBottom(Math.max(0, window.innerHeight - (trigger.current?.getBoundingClientRect().top ?? 0) + 8)) }
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && root.current?.contains(event.target) !== true) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus() } }
    place()
    window.addEventListener('resize', place)
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { window.removeEventListener('resize', place); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open])
  const meter = (reading: Bucket): ReactNode => {
    const label = `${reading.group}: ${reading.label}`
    return <div className={css.section}>
      <div className={css.meterRow}><span>{label}</span><span>{reading ? t('remaining', { percent: String(reading.remaining) }) : t('unknown')}</span></div>
      {reading ? <div className={css.track} role="meter" aria-label={label} aria-valuenow={reading.remaining} aria-valuemin={0} aria-valuemax={100}>
        <div className={css.fill} style={{ width: `${String(reading.remaining)}%` }} />
      </div> : null}
      {reading?.resetsAt ? <div className={css.resets}>{t('resets', { time: new Date(reading.resetsAt * 1000).toLocaleString() })}</div> : null}
    </div>
  }
  return <div ref={root} className={css.root}>
    <button ref={trigger} type="button" className={css.trigger} title={t('title')} aria-label={t('title')} aria-expanded={open} onClick={() => { setOpen(!open) }}>
      <span className={css.triggerIcon} aria-hidden="true">◉</span>
      {wide ? <span className={css.triggerLabel}>{t('title')}</span> : null}
      <span className={css.triggerValue}>{summary ? t('remaining', { percent: String(summary.remaining) }) : '—'}</span>
    </button>
    {open ? <div className={css.panel} style={{ bottom }} role="dialog" aria-label={t('title')}>
      <h3 className={css.title}>{t('title')}</h3>
      {rows.length ? rows.map(row => <section key={`${row.group}:${row.id}`}><div className={css.sectionHead}>{row.group}</div>{meter(row)}</section>) : <p className={css.empty}>{t('empty')}</p>}
      {section?.refreshState === 'failed' || writeFailed ? <p className={css.note} role="status">{t('failed')}</p> : null}
      <p className={css.note}>{t('note')}</p>
      <div className={css.footer}>
        <span className={css.stamp}>{running ? t('running') : captured ? t('captured', { time: new Date(captured).toLocaleString() }) : t('never')}</span>
        <button className={css.refreshBtn} type="button" disabled={running || !snapshot.writable} onClick={() => {
          setWriteFailed(false)
          void refresh().catch(() => { setWriteFailed(true) })
        }}>{t('refresh')}</button>
      </div>
    </div> : null}
  </div>
}
