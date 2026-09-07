// @vitest-environment jsdom
/**
 * The Codex quota panel: where it registers, and what it renders.
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
import { CodexQuota, type CodexQuotaProps } from '../src/client/CodexQuota.tsx'
import { en, zh } from '../src/client/locales.ts'
import { apply } from '../src/client/index.ts'

afterEach(cleanup)

/** The slot spec the panel registers, as much of it as these tests read. */
interface SlotSpec { order: number; inject: () => void }

describe('Codex quota panel', () => {
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
    expect(spec?.order).toBeLessThan(0)
    spec?.inject()
    expect(bind).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'codex-quota' }))
    remove()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('renders percentages left including zero, unknown windows, and requests refresh', async () => {
    const set = vi.fn(async () => {})
    const snapshot = { writable: true, value: { bucketsJson: JSON.stringify([{ id: 'codex', label: 'codex', primary: { remaining: 0, minutes: 300, resetsAt: null }, secondary: null }]), refreshState: 'failed' } }
    const settings = { subscribe: () => () => {}, getSnapshot: () => snapshot, set }
    const t = (key: keyof typeof en, values: Record<string, string> = {}) => Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, v), en[key])
    // Spread from a typed object: `{...(x as never)}` is not spreadable, since
    // `never` is not an object type.
    const props = { wide: true, t, settings } as unknown as CodexQuotaProps
    const { container } = render(<CodexQuota {...props} />)
    expect(container.textContent).toContain('0% left')
    const trigger = container.querySelector('button')
    await act(async () => { if (trigger !== null) fireEvent.click(trigger) })
    expect(container.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('0')
    expect(container.textContent).toContain('Unavailable')
    expect(container.textContent).toContain('Last reading may be stale')
    const refresh = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Refresh')
    await act(async () => { if (refresh !== undefined) fireEvent.click(refresh) })
    expect(set).toHaveBeenCalledWith('refreshRequestedAt', expect.any(Number))
  })

  it('ships matching English and Chinese copy', () => { expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort()) })
})
