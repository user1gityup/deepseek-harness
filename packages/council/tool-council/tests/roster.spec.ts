import { describe, expect, it } from 'vitest'
import { assignWorkers, defaultRoster, inferKind } from '../src/roster.ts'
import type { Worker } from '../src/roster.ts'
import type { SubTask } from '../src/decompose.ts'

/** Build a unit with sensible defaults. */
function task(id: string, title = id, detail = '', provider?: string): SubTask {
  return { id, title, detail, dependsOn: [], ...provider === undefined ? {} : { provider } }
}

const CLAUDE: Worker = {
  provider: 'claude-code', name: 'Claude', enabled: true,
  costClass: 'included', kinds: ['code', 'tests', 'any'],
}
const CODEX: Worker = {
  provider: 'codex', name: 'OpenAI', enabled: true,
  costClass: 'included', kinds: ['code', 'any'],
}
const METERED: Worker = {
  provider: 'spawn', name: 'Metered', enabled: true,
  costClass: 'metered', kinds: ['any'],
}

describe('inferKind', () => {
  it('reads implementation work as code', () => {
    expect(inferKind(task('a', 'Implement the parser'))).toBe('code')
  })
  it('reads test work as tests', () => {
    expect(inferKind(task('a', 'Add spec coverage for the tally'))).toBe('tests')
  })
  it('reads documentation as docs', () => {
    expect(inferKind(task('a', 'Update the README'))).toBe('docs')
  })
  it('falls back to any when nothing matches', () => {
    expect(inferKind(task('a', 'Consider the situation'))).toBe('any')
  })
})

describe('assignWorkers', () => {
  it('prefers a subscription worker over a metered one', () => {
    // The whole point: work that is free at the margin should go to the seat
    // already paid for.
    const plan = assignWorkers([task('a', 'Implement a feature')], [METERED, CLAUDE])
    expect(plan.assignments[0]?.provider).toBe('claude-code')
    expect(plan.assignments[0]?.reason).toContain('subscription')
  })

  it('never assigns a disabled worker', () => {
    const off: Worker = { ...CLAUDE, enabled: false }
    const plan = assignWorkers([task('a', 'Implement a feature')], [off, METERED])
    expect(plan.assignments[0]?.provider).toBe('spawn')
  })

  it('refuses to re-enable a disabled worker the decomposition named', () => {
    // A decomposition must not be able to overrule the user's own switch.
    const off: Worker = { ...CLAUDE, enabled: false }
    const plan = assignWorkers([task('a', 'Work', '', 'claude-code')], [off, METERED])
    expect(plan.assignments[0]?.provider).toBe('spawn')
  })

  it('honours an explicit provider when that worker is enabled', () => {
    const plan = assignWorkers([task('a', 'Work', '', 'codex')], [CLAUDE, CODEX])
    expect(plan.assignments[0]?.provider).toBe('codex')
    expect(plan.assignments[0]?.reason).toContain('named')
  })

  it('spreads load across equally-priced workers', () => {
    const tasks = ['a', 'b', 'c', 'd'].map(id => task(id, 'Implement something'))
    const plan = assignWorkers(tasks, [CLAUDE, CODEX])
    expect(plan.load.get('claude-code')).toBe(2)
    expect(plan.load.get('codex')).toBe(2)
  })

  it('respects a worker concurrency ceiling', () => {
    const capped: Worker = { ...CLAUDE, maxConcurrent: 1 }
    const tasks = ['a', 'b'].map(id => task(id, 'Implement something'))
    const plan = assignWorkers(tasks, [capped, METERED])
    expect(plan.load.get('claude-code')).toBe(1)
    expect(plan.load.get('spawn')).toBe(1)
  })

  it('reports units nobody can take rather than inventing a worker', () => {
    const plan = assignWorkers([task('a', 'Implement something')], [])
    expect(plan.unassigned).toEqual(['a'])
    expect(plan.assignments[0]?.provider).toBeUndefined()
  })

  it('falls back to an any-worker when no worker declares the kind', () => {
    const docsOnly: Worker = { ...CLAUDE, kinds: ['docs'] }
    const plan = assignWorkers([task('a', 'Implement something')], [docsOnly, METERED])
    expect(plan.assignments[0]?.provider).toBe('spawn')
  })
})

describe('defaultRoster', () => {
  it('includes only providers actually registered on this host', () => {
    const roster = defaultRoster(['claude-code'])
    expect(roster.map(w => w.provider)).toEqual(['claude-code'])
  })

  it('puts the subscription workers on by default and the metered one off', () => {
    const roster = defaultRoster(['claude-code', 'codex', 'spawn'])
    expect(roster.find(w => w.provider === 'claude-code')?.enabled).toBe(true)
    expect(roster.find(w => w.provider === 'codex')?.enabled).toBe(true)
    expect(roster.find(w => w.provider === 'spawn')?.enabled).toBe(false)
  })

  it('is empty when nothing is registered', () => {
    expect(defaultRoster([])).toEqual([])
  })
})
