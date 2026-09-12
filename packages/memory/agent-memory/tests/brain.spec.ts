/**
 * Remembered facts crossing machines.
 *
 * One machine's entries go into the shared note; what the other machines put
 * there comes back into this machine's digest, which is what every agent and
 * council seat reads.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FACTS_NOTE, factLine, parseSharedFacts, shareFacts } from '../src/brain.ts'
import { renderDigest } from '../src/index.ts'
import type { MemoryEntry } from '../src/spec.ts'

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'mlocal',
    kind: 'fact',
    text: 'The council runs a planning round first.',
    tags: ['council', 'cost'],
    scope: 'global',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

const FOREIGN = '- [decision] Free seats carry the grunt work. _(swarm)_ - remembered on VMIXER2O2 <!-- dsh-fact id=mfar machine=VMIXER2O2 -->'

describe('shareFacts', () => {
  let brain: string
  let note: string

  beforeEach(() => {
    brain = mkdtempSync(join(tmpdir(), 'memory-brain-'))
    note = join(brain, FACTS_NOTE)
    mkdirSync(join(brain, '.sync'), { recursive: true })
    writeFileSync(note, `# DSH remembered facts\n\n<!-- ENTRIES BELOW THIS LINE -->\n${FOREIGN}\n`)
  })

  afterEach(() => {
    rmSync(brain, { recursive: true, force: true })
  })

  it('publishes local entries with their kind, tags and id', () => {
    shareFacts([entry()], { brainDir: brain, machine: 'A' })
    expect(readFileSync(note, 'utf8')).toContain(
      '- [fact] The council runs a planning round first. _(council, cost)_ - remembered on A'
      + ' <!-- dsh-fact id=mlocal machine=A -->',
    )
  })

  it('returns only what other machines hold, and publishes each fact once', () => {
    const first = shareFacts([entry()], { brainDir: brain, machine: 'A' })
    expect(first).toEqual([{ id: 'mfar', kind: 'decision', body: 'Free seats carry the grunt work. _(swarm)_', machine: 'VMIXER2O2' }])
    shareFacts([entry()], { brainDir: brain, machine: 'A' })
    const lines = readFileSync(note, 'utf8').split('\n').filter(line => line.includes('id=mlocal'))
    expect(lines).toHaveLength(1)
  })

  it('writes home folders as ~ and keeps an untagged fact plain', () => {
    const line = factLine(entry({ id: 'mpath', tags: [], text: `Harness at ${join(homedir(), 'Documents')}` }), 'A')
    expect(line).not.toContain(homedir())
    expect(line).toContain('- [fact] Harness at ~')
    expect(line).not.toContain('_(')
  })

  it('shares nothing when it is off, or when the note is not there yet', () => {
    expect(shareFacts([entry()], { brainDir: false })).toEqual([])
    rmSync(note)
    expect(shareFacts([entry()], { brainDir: brain })).toEqual([])
  })

  it('ignores lines that are not facts', () => {
    expect(parseSharedFacts('# Heading\n\n- a plain bullet\n- [nonsense] x - remembered on A <!-- dsh-fact id=m1 -->\n')).toEqual([])
  })
})

describe('renderDigest with shared facts', () => {
  it('renders the other machines under their own heading', () => {
    const digest = renderDigest([entry()], 200, parseSharedFacts(FOREIGN))
    expect(digest).toContain('## fact')
    expect(digest).toContain('## remembered on other machines')
    expect(digest).toContain('- [decision] Free seats carry the grunt work. _(swarm)_ - VMIXER2O2')
    expect(digest.indexOf('## fact')).toBeLessThan(digest.indexOf('## remembered on other machines'))
  })

  it('still renders when only other machines remember anything', () => {
    const digest = renderDigest([], 200, parseSharedFacts(FOREIGN))
    expect(digest).not.toContain('No memories recorded yet')
    expect(digest).toContain('VMIXER2O2')
  })

  it('says so when nobody remembers anything', () => {
    expect(renderDigest([], 200, [])).toContain('_No memories recorded yet._')
  })
})
