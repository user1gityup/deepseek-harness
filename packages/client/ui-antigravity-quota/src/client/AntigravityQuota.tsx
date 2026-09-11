/** Remaining quota projection; settings are supplied by the host reader. */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { NS } from './locales.ts'
import css from './AntigravityQuota.module.css'

interface Bucket { id: string; group: string; label: string; remaining: number; resetsAt: number | null }
/** One account row the host publishes; it carries no account identifier. */
interface Seat {
  id: string
  label: string
  source: string
  state: string
  tierName: string
  counted: boolean
  inflight: number
  parkedUntil: number | null
  buckets: Bucket[]
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
function isBucket(row: unknown): row is Bucket {
  return object(row) && typeof row.id === 'string'
    && typeof row.label === 'string' && typeof row.group === 'string'
    && typeof row.remaining === 'number' && Number.isFinite(row.remaining) && row.remaining >= 0 && row.remaining <= 100
    && (row.resetsAt === null || (typeof row.resetsAt === 'number' && Number.isFinite(row.resetsAt) && row.resetsAt > 0 && row.resetsAt < 8.64e12))
}
function parsed(value: unknown): unknown[] {
  if (typeof value !== 'string') return []
  let rows: unknown
  try { rows = JSON.parse(value) } catch { return [] }
  return Array.isArray(rows) ? rows : []
}
function buckets(value: unknown): Bucket[] {
  return parsed(value).filter(isBucket)
}
function seats(value: unknown): Seat[] {
  return parsed(value).flatMap((row): Seat[] => {
    if (!object(row) || typeof row.id !== 'string' || typeof row.label !== 'string' || typeof row.state !== 'string') return []
    return [{
      id: row.id,
      label: row.label,
      source: typeof row.source === 'string' ? row.source : 'seat',
      state: row.state,
      tierName: typeof row.tierName === 'string' ? row.tierName : '',
      counted: row.counted === true,
      inflight: typeof row.inflight === 'number' && Number.isFinite(row.inflight) && row.inflight > 0 ? row.inflight : 0,
      parkedUntil: typeof row.parkedUntil === 'number' && Number.isFinite(row.parkedUntil) ? row.parkedUntil : null,
      buckets: Array.isArray(row.buckets) ? row.buckets.filter(isBucket) : [],
    }]
  })
}
/**
 * Compact time until a moment: `3d 4h`, `5h 12m`, `12m`.
 * @param ms - Milliseconds remaining.
 * @returns the countdown text; `0m` once the moment has passed.
 */
export function timeLeft(ms: number): string {
  if (!(ms > 0)) return '0m'
  const minutes = Math.floor(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return `${String(days)}d ${String(hours)}h`
  return hours > 0 ? `${String(hours)}h ${String(mins)}m` : `${String(mins)}m`
}
/** Sidebar runtime, locale, and settings inputs. */
export type AntigravityQuotaProps = PropsRuntime<'sidebar.region.action'> & PropsLocale<typeof NS>
  & InjectFace<{ hooks: { quota: SettingsScope<Record<string, unknown>> }; refresh: () => Promise<void> }>
/**
 * Render the pool-wide remaining percentages, each account's own reading, and manual refresh.
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
  const pool = seats(section?.seatsJson)
  // Gemini is the bucket headless seats actually spend, so it is the headline.
  const summary = rows.find(row => row.id === 'gemini-weekly') ?? rows[0]
  const counted = pool.filter(seat => seat.counted).length
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
  const now = Date.now()
  const meter = (reading: Bucket): ReactNode => {
    const label = `${reading.group}: ${reading.label}`
    return <div className={css.section}>
      <div className={css.meterRow}><span>{label}</span><span>{t('remaining', { percent: String(reading.remaining) })}</span></div>
      <div className={css.track} role="meter" aria-label={label} aria-valuenow={reading.remaining} aria-valuemin={0} aria-valuemax={100}>
        <div className={css.fill} style={{ width: `${String(reading.remaining)}%` }} />
      </div>
      {reading.resetsAt ? <div className={css.resets}>
        {t('resets', { time: new Date(reading.resetsAt * 1000).toLocaleString() })} · {t('resetsIn', { time: timeLeft(reading.resetsAt * 1000 - now) })}
      </div> : null}
    </div>
  }
  const status = (seat: Seat): string => {
    if (seat.state === 'down') return t('stateDown')
    if (seat.state === 'signed-out') return t('stateSignedOut')
    if (seat.state !== 'ok') return t('stateError')
    return [
      seat.tierName,
      seat.inflight > 0 ? t('inflight', { count: String(seat.inflight) }) : '',
      seat.parkedUntil !== null && seat.parkedUntil > now ? t('parked', { time: timeLeft(seat.parkedUntil - now) }) : '',
      seat.counted ? '' : t('duplicate'),
    ].filter(part => part !== '').join(' · ')
  }
  return <div ref={root} className={css.root}>
    <button ref={trigger} type="button" className={css.trigger} title={t('title')} aria-label={t('title')} aria-expanded={open} onClick={() => { setOpen(!open) }}>
      <span className={css.triggerIcon} aria-hidden="true">◉</span>
      {wide ? <span className={css.triggerLabel}>{t('title')}</span> : null}
      <span className={css.triggerValue}>{summary ? t('remaining', { percent: String(summary.remaining) }) : '—'}</span>
    </button>
    {open ? <div className={css.panel} style={{ bottom }} role="dialog" aria-label={t('title')}>
      <h3 className={css.title}>{t('title')}</h3>
      {rows.length ? <section>
        <div className={css.sectionHead}>{counted > 0 ? t('combined', { count: String(counted) }) : t('combinedUnknown')}</div>
        {rows.map(row => <div key={`${row.group}:${row.id}`}>{meter(row)}</div>)}
      </section> : <p className={css.empty}>{t('empty')}</p>}
      {pool.length ? <section className={css.seats}>
        <div className={css.sectionHead}>{t('accounts')}</div>
        {pool.map(seat => <div key={seat.id} className={css.seat} data-state={seat.state}>
          <div className={css.meterRow}>
            <span className={css.seatName}>{seat.source === 'ide' ? t('ide') : seat.label}</span>
            <span className={css.seatStatus}>{status(seat)}</span>
          </div>
          {seat.buckets.map(reading => <div key={reading.id} className={css.seatBucket}>
            <span>{reading.group}</span>
            <span className={css.meterValue}>
              {t('remaining', { percent: String(reading.remaining) })}{reading.resetsAt ? ` · ${t('resetsIn', { time: timeLeft(reading.resetsAt * 1000 - now) })}` : ''}
            </span>
          </div>)}
        </div>)}
      </section> : null}
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
