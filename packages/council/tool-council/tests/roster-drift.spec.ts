import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_SEATS } from '../src/seats.ts'

/**
 * The budget panel keeps its own copy of the seat roster.
 *
 * The client and host faces share no module, so the panel's list is maintained
 * by hand against `seats.ts`. Nothing enforces that by construction, and the
 * failure is silent in the worst way: a seat added to the host but not the
 * panel simply does not appear, with no error anywhere, so it cannot be
 * switched on and looks broken rather than missing.
 *
 * That happened — `free-claude` was added to the host and was invisible in the
 * panel. This test is the tripwire that would have caught it.
 */

/** Panel source, read as text because it belongs to the other face. */
function panelSource(): string {
  const path = join(
    import.meta.dirname,
    '..', '..', '..',
    'client', 'ui-council-budget', 'src', 'client', 'CouncilBudget.tsx',
  )
  return readFileSync(path, 'utf8')
}

/** Seat ids the panel declares in its mirrored roster. */
function panelSeatIds(source: string): readonly string[] {
  const marker = source.indexOf('const DEFAULT_SEATS')
  if (marker === -1) return []
  // Start AFTER the opening bracket of the array literal: the first ']' in
  // `readonly PanelSeat[]` would otherwise end the block before any entry.
  const start = source.indexOf('= [', marker)
  if (start === -1) return []
  const end = source.indexOf(']', start + 3)
  const block = source.slice(start, end)
  return [...block.matchAll(/id:\s*'([^']+)'/g)].map(match => match[1] ?? '')
}

describe('the panel roster matches the shipped seats', () => {
  it('lists every seat the council ships, in the same order', () => {
    const panel = panelSeatIds(panelSource())
    const host = DEFAULT_SEATS.map(seat => seat.id)
    expect(panel).toEqual(host)
  })

  it('finds a roster in the panel at all', () => {
    // Guards the test itself: a rename that broke the parse would otherwise
    // make this suite pass by comparing two empty lists.
    expect(panelSeatIds(panelSource()).length).toBeGreaterThan(0)
  })
})
