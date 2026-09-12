/**
 * Remembered facts crossing machines.
 *
 * One machine's entries go into the shared note; what the other machines put
 * there comes back into this machine's digest, which is what every agent and
 * council seat reads.
 *
 * The id is the part that decides whether a fact appears once or once per
 * machine, so it is taken from the text with home folders written as `~` -
 * never from the raw text, and never from the entry's own id.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FACTS_NOTE, factLine, parseSharedFacts, shareFacts, sharedFactId } from '../src/brain.ts'
import { renderDigest } from '../src/index.ts'
import type { MemoryEntry } from '../src/spec.ts'

const TEXT = 'The council runs a planning round first.'

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'mlocal',
    kind: 'fact',
    text: TEXT,
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

  it('publishes local entries with their kind, tags and shared id', () => {
    shareFacts([entry()], { brainDir: brain, machine: 'A' })
    expect(readFileSync(note, 'utf8')).toContain(
      `- [fact] ${TEXT} _(council, cost)_ - remembered on A <!-- dsh-fact id=${sharedFactId(TEXT)} machine=A -->`,
    )
  })

  it('returns only what other machines hold, and publishes each fact once', () => {
    const first = shareFacts([entry()], { brainDir: brain, machine: 'A' })
    expect(first).toEqual([{ id: 'mfar', kind: 'decision', body: 'Free seats carry the grunt work. _(swarm)_', machine: 'VMIXER2O2' }])
    shareFacts([entry()], { brainDir: brain, machine: 'A' })
    const lines = readFileSync(note, 'utf8').split('\n').filter(line => line.includes(`id=${sharedFactId(TEXT)}`))
    expect(lines).toHaveLength(1)
  })

  it('writes home folders as ~ and keeps an untagged fact plain', () => {
    const line = factLine(entry({ tags: [], text: `Harness at ${join(homedir(), 'Documents')}` }), 'A')
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

  it('keeps one fact to one line however each machine spells its home folder', () => {
    const here = `The harness is at ${join(homedir(), 'Documents', 'claudecode')}.`
    const elsewhere = ['The harness is at ~', 'Documents', 'claudecode.'].join('\\')
    // Same fact, two machines: different raw text, different entry id, and on
    // the machine that did not write it the text is already normalised.
    shareFacts([entry({ id: 'mraw', text: here, tags: [] })], { brainDir: brain, machine: 'A' })
    shareFacts([entry({ id: 'mother', text: elsewhere, tags: [] })], { brainDir: brain, machine: 'B' })
    const lines = readFileSync(note, 'utf8').split('\n').filter(line => line.includes('The harness is at'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('machine=A')
  })
})

describe('sharedFactId', () => {
  it('is the same for one fact however its home folder is written', () => {
    const here = `The harness is at ${join(homedir(), 'Documents')}.`
    const elsewhere = 'The harness is at ~\\Documents.'
    expect(sharedFactId(here)).toBe(sharedFactId(elsewhere))
    expect(sharedFactId('a different fact')).not.toBe(sharedFactId(here))
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
