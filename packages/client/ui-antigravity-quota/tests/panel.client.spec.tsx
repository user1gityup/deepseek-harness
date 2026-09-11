// @vitest-environment jsdom
/**
 * The Antigravity quota panel: where it registers, and what it renders.
 *
 * Mounted through `@testing-library/react` rather than a hand-rolled
 * `createRoot`. The repo has no `@types/react-dom`, so importing
 * `react-dom/client` directly type-checks as `any` and fails the client build
 * under `noImplicitAny` — and testing-library is what every other client
 * component spec here already uses, so the convention and the type both point
 * the same way. The assertions are unchanged.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { AntigravityQuota, timeLeft, type AntigravityQuotaProps } from '../src/client/AntigravityQuota.tsx'
import { en, zh } from '../src/client/locales.ts'
import { apply } from '../src/client/index.ts'

afterEach(cleanup)

/** The slot spec the panel registers, as much of it as these tests read. */
interface SlotSpec { order: number; inject: () => void }

describe('Antigravity quota panel', () => {
  it('registers before Claude only when the sidebar slot exists and disposes contributions', () => {
    const dispose = vi.fn()
    // Typed by its parameter, not just its return: `vi.fn(() => dispose)` infers
    // an empty argument tuple, so reading `calls[0][0]` off it is an index into
    // a zero-length tuple and does not compile.
    const register = vi.fn((_spec: SlotSpec) => dispose)
    const bind = vi.fn()
    let install: (() => unknown) | undefined
    apply({ effect: (f: () => unknown) => f(), locale: { register: () => () => {} },
      slots: { inject: (name: string, f: () => unknown) => { expect(name).toBe('sidebar.region.action'); install = f }, register },
      settingsScope: { bind },
    } as never)
    expect(register).not.toHaveBeenCalled()
    const remove = install?.() as () => void
    const spec = register.mock.calls[0]?.[0]
    expect(spec?.order).toBe(-2)
    spec?.inject()
    expect(bind).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'antigravity-quota' }))
    remove()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('renders percentages left including zero, unknown windows, and requests refresh', async () => {
    const set = vi.fn(async (_field: string, _value: number) => {})
    const snapshot = { writable: true, value: { bucketsJson: JSON.stringify([{ id: 'antigravity', label: 'antigravity', group: 'Gemini Models', remaining: 0, resetsAt: null }]), refreshState: 'failed' } }
    const t = (key: keyof typeof en, values: Record<string, string> = {}) => Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, v), en[key])
    // Spread from a typed object: `{...(x as never)}` is not spreadable, since
    // `never` is not an object type.
    const props = { wide: true, t, useQuota: (select: (s: unknown) => unknown) => select(snapshot), refresh: () => set('refreshRequestedAt', Date.now()) } as unknown as AntigravityQuotaProps
    const { container } = render(<AntigravityQuota {...props} />)
    expect(container.textContent).toContain('0% left')
    const trigger = container.querySelector('button')
    await act(async () => { if (trigger !== null) fireEvent.click(trigger) })
    expect(container.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('0')
    expect(container.textContent).toContain('Gemini Models')
    expect(container.textContent).toContain('Last reading may be stale')
    const refresh = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Refresh')
    await act(async () => { if (refresh !== undefined) fireEvent.click(refresh) })
    expect(set).toHaveBeenCalledWith('refreshRequestedAt', expect.any(Number))
  })

  it('headlines the combined Gemini bucket and lists each account with its state', async () => {
    const soon = Math.floor(Date.now() / 1000) + 3 * 86_400 + 4 * 3600 + 120
    const snapshot = { writable: true, value: {
      bucketsJson: JSON.stringify([
        { id: '3p-weekly', label: 'Weekly', group: 'Claude and GPT models', remaining: 99.9, resetsAt: soon, accounts: 2 },
        { id: 'gemini-weekly', label: 'Weekly', group: 'Gemini Models', remaining: 64.1, resetsAt: soon, accounts: 2 },
      ]),
      seatsJson: JSON.stringify([
        { id: 'seat1', label: 'Shift A', source: 'seat', state: 'ok', tierName: 'Google AI Plus', counted: true, inflight: 2, parkedUntil: null,
          buckets: [{ id: 'gemini-weekly', label: 'Weekly', group: 'Gemini Models', remaining: 97.6, resetsAt: soon }] },
        { id: 'gone1', label: 'Google One', source: 'seat', state: 'ok', tierName: 'Google AI Plus', counted: true, inflight: 0,
          parkedUntil: Date.now() + 3_630_000, buckets: [] },
        { id: 'fam1', label: 'family', source: 'seat', state: 'down', tierName: '', counted: false, inflight: 0, parkedUntil: null, buckets: [] },
        { id: 'ide', label: 'Antigravity IDE', source: 'ide', state: 'ok', tierName: 'Google AI Plus', counted: false, inflight: 0,
          parkedUntil: null, buckets: [] },
        { id: 'broken' },
      ]),
      refreshState: 'ok', capturedAt: Date.now() } }
    const t = (key: keyof typeof en, values: Record<string, string> = {}) => Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, v), en[key])
    const props = {
      wide: false, t, useQuota: (select: (s: unknown) => unknown) => select(snapshot), refresh: async () => {},
    } as unknown as AntigravityQuotaProps
    const { container } = render(<AntigravityQuota {...props} />)
    expect(container.querySelector('button')?.textContent).toContain('64.1% left')
    await act(async () => { const trigger = container.querySelector('button'); if (trigger !== null) fireEvent.click(trigger) })
    const text = container.textContent ?? ''
    expect(text).toContain('All accounts combined (2)')
    expect(text).toContain('Shift A')
    expect(text).toContain('Google AI Plus · 2 running')
    expect(text).toContain('parked 1h 0m')
    expect(text).toContain('Not running')
    expect(text).toContain('same account, counted once')
    expect(text).toContain('refills in 3d 4h')
    expect(container.querySelectorAll('[data-state]')).toHaveLength(4)
  })

  it('formats countdowns', () => {
    expect(timeLeft(-1)).toBe('0m')
    expect(timeLeft(12 * 60_000)).toBe('12m')
    expect(timeLeft(5 * 3_600_000 + 12 * 60_000)).toBe('5h 12m')
    expect(timeLeft(3 * 86_400_000 + 4 * 3_600_000)).toBe('3d 4h')
  })

  it('ships matching English and Chinese copy', () => { expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort()) })
})
