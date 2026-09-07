import { describe, expect, it } from 'vitest'
import { parseLimits } from '../src/reading.ts'
import { Config } from '../src/index.ts'

describe('Codex remaining quota', () => {
  it('boots with flat defaults', () => { expect(Config({})).toMatchObject({ bucketsJson: '[]', refreshIntervalMs: 300_000 }) })
  it('converts used to remaining and prefers independent buckets over legacy data', () => {
    expect(parseLimits({ rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: {
      codex: { primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 100 } },
      review: { limitName: 'Code review', primary: { usedPercent: 0 } },
    } })).toEqual([
      { id: 'codex', label: 'codex', primary: { remaining: 77, minutes: 300, resetsAt: 1800000000 }, secondary: { remaining: 0, minutes: null, resetsAt: null } },
      { id: 'review', label: 'Code review', primary: { remaining: 100, minutes: null, resetsAt: null }, secondary: null },
    ])
  })
  it('keeps absent and invalid values unknown', () => {
    expect(parseLimits({ rateLimits: { primary: { usedPercent: null }, secondary: { usedPercent: '0' } } })[0]).toMatchObject({ primary: null, secondary: null })
    expect(parseLimits({ rateLimits: null })).toEqual([])
    expect(() => parseLimits(null)).toThrow()
  })
  it('supports the legacy response and clamps reported overages', () => {
    const clamped = parseLimits({
      rateLimitsByLimitId: {},
      rateLimits: { primary: { usedPercent: 105 }, secondary: { usedPercent: -2 } },
    })[0]
    expect(clamped).toMatchObject({ primary: { remaining: 0 }, secondary: { remaining: 100 } })
  })
})
