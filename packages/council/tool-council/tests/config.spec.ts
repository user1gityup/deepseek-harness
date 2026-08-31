import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'

/**
 * Boot-time schema guards.
 *
 * The host resolves this schema before the plugin loads. A schema that cannot
 * validate its own empty default takes the whole application down at launch
 * with a ValidationError, which no unit test of behaviour would ever catch.
 * This has happened twice: a nested object whose required fields were missing
 * from the materialised default, and an array default that overwrote real
 * values. Both were only visible at boot.
 */
describe('config schema survives boot', () => {
  it('validates an empty config, as a fresh install supplies', () => {
    expect(() => Config({})).not.toThrow()
  })

  it('validates a config carrying only the council-mode switch', () => {
    expect(() => Config({ councilMode: true })).not.toThrow()
  })

  it('validates with approval state absent, which is the normal case', () => {
    const resolved = Config({}) as Record<string, unknown>
    // Absent, not an empty object: a materialised {} fails its own required fields.
    expect(resolved['pendingPlanId']).toBeUndefined()
    expect(resolved['approvedPlanId']).toBeUndefined()
  })

  it('validates with a full approval state present', () => {
    expect(() => Config({
      pendingPlanId: 'p1',
      pendingPlanQuery: 'q',
      pendingPlanText: 'plan',
      pendingPlanIssuedAt: 1,
      approvedPlanId: 'p1',
      approvedAt: 2,
    })).not.toThrow()
  })

  it('leaves seat overrides absent rather than materialising empty arrays', () => {
    // An empty args array once replaced a seat's real defaults, so a seat
    // toggled in the UI spawned its command with no prompt at all.
    const resolved = Config({ seats: { openai: { enabled: false } } }) as Record<string, unknown>
    const seats = resolved['seats'] as Record<string, Record<string, unknown>> | undefined
    const args = seats?.['openai']?.['args']
    expect(args === undefined || (Array.isArray(args) && args.length === 0)).toBe(true)
  })
})

describe('auto-approve', () => {
  it('defaults to off, so the gate is on unless a person turns it off', () => {
    const resolved = Config({}) as Record<string, unknown>
    expect(resolved['autoApprove']).toBe(false)
  })

  it('accepts being switched on', () => {
    const resolved = Config({ autoApprove: true }) as Record<string, unknown>
    expect(resolved['autoApprove']).toBe(true)
  })
})
