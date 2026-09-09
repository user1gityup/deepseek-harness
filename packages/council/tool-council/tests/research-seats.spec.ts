import { describe, expect, it, vi } from 'vitest'
import { researchSeats } from '../src/research-seats.ts'
import type { SeatConfig } from '../src/seats.ts'

const worker = (id: string): SeatConfig => ({ id, name: id, enabled: true, free: true, nativeWebSearch: true, transport: 'cli' })

describe('free seat research', () => {
  it('distributes concurrent searches and excludes disabled, paid and tool-less seats', async () => {
    const ask = vi.fn(async (seat: SeatConfig) => ({ seat: seat.id, text: '{"sources":[{"url":"https://example.com","snippet":"verified"}]}', ms: 1 }))
    const seam = researchSeats([worker('a'), worker('b'), { ...worker('off'), enabled: false }, { ...worker('paid'), free: false }, { ...worker('blind'), nativeWebSearch: false }], ask, undefined)!
    const results = await Promise.all(['one', 'two', 'three'].map(query => seam.search({ query })))
    expect(ask.mock.calls.map(([seat]) => seat.id)).toEqual(['a', 'b', 'a'])
    expect(results[0]?.sources[0]?.url).toBe('https://example.com/')
  })
  it('falls back on failed or unusable model output', async () => {
    const fallback = { search: vi.fn(async () => ({ sources: [] })) }
    for (const text of ['not json', '{"sources":[{"url":"file:///secret"}]}']) {
      const seam = researchSeats([worker('a')], async () => ({ seat: 'a', text, ms: 0 }), fallback)!
      await seam.search({ query: 'test' })
    }
    expect(fallback.search).toHaveBeenCalledTimes(2)
  })
  it('preserves cancellation without starting fallback work', async () => {
    const fallback = { search: vi.fn() }
    const ask = vi.fn()
    const seam = researchSeats([worker('a')], ask, fallback)!
    await expect(seam.search({ query: 'test' }, AbortSignal.abort())).rejects.toThrow()
    expect(ask).not.toHaveBeenCalled()
    expect(fallback.search).not.toHaveBeenCalled()
    expect(researchSeats([], ask, fallback)).toBe(fallback)
  })
})
