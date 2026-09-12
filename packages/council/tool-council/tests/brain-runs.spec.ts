/**
 * Sharing a finished run with the other machines.
 *
 * The line has to be byte-identical to the one the brain's own tooling writes
 * when it collects the same record from disk, or the run shows up twice.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RUNS_NOTE, SYNC_INTERVAL_MS, brainSyncSeam, runLine, shareRun, withoutHomePaths } from '../src/brain.ts'
import type { ShareableRun } from '../src/brain.ts'

const RUN: ShareableRun = {
  id: '11111111-2222-4333-8444-555555555555',
  query: 'Check the pipeline end to end\n on a small task',
  at: Date.UTC(2026, 8, 11, 9, 30),
  seatIds: ['claude', 'kimi'],
  drafts: [{ text: 'a draft' }, { text: '', error: 'timeout' }],
  reviews: [{ seat: 'claude' }],
  amendments: 1,
}

describe('shareRun', () => {
  let brain: string
  let note: string
  let requests: string[]

  beforeEach(() => {
    brain = mkdtempSync(join(tmpdir(), 'council-brain-'))
    note = join(brain, RUNS_NOTE)
    mkdirSync(join(brain, '.sync'), { recursive: true })
    writeFileSync(note, '# DSH saved runs\n\n<!-- ENTRIES BELOW THIS LINE -->\n')
    requests = []
    vi.spyOn(brainSyncSeam, 'request').mockImplementation((dir: string) => { requests.push(dir) })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(brain, { recursive: true, force: true })
  })

  it('writes one line naming the machine, seats, drafts and amendments', () => {
    expect(shareRun(RUN, { brainDir: brain, machine: 'VMIXER2O2', now: 1 })).toBe(true)
    expect(readFileSync(note, 'utf8')).toContain(
      '- 2026-09-11 09:30Z on VMIXER2O2 - "Check the pipeline end to end on a small task"'
      + ' - seats: claude kimi; drafts 1/2; reviews 1; amendments 1'
      + ' <!-- dsh-run id=11111111-2222-4333-8444-555555555555 machine=VMIXER2O2 -->',
    )
  })

  it('shares a run once, however often it is filed', () => {
    expect(shareRun(RUN, { brainDir: brain, machine: 'A', now: 1 })).toBe(true)
    expect(shareRun(RUN, { brainDir: brain, machine: 'A', now: 2 })).toBe(false)
    const lines = readFileSync(note, 'utf8').split('\n').filter(line => line.startsWith('- '))
    expect(lines).toHaveLength(1)
  })

  it('asks the brain to commit, but not on every run', () => {
    shareRun(RUN, { brainDir: brain, machine: 'A', now: 10 * SYNC_INTERVAL_MS })
    shareRun({ ...RUN, id: 'second-run' }, { brainDir: brain, machine: 'A', now: 10 * SYNC_INTERVAL_MS + 1 })
    shareRun({ ...RUN, id: 'third-run' }, { brainDir: brain, machine: 'A', now: 11 * SYNC_INTERVAL_MS + 2 })
    expect(requests).toEqual([brain, brain])
  })

  it('never asks when sharing is off, and stays quiet when the note is absent', () => {
    expect(shareRun(RUN, { brainDir: false })).toBe(false)
    rmSync(note)
    expect(shareRun(RUN, { brainDir: brain, now: 1 })).toBe(false)
    expect(existsSync(note)).toBe(false)
    expect(requests).toEqual([])
  })

  it('writes home folders as ~, which shared notes require', () => {
    const query = `Fix the build in ${join(homedir(), 'Documents', 'claudecode')}`
    const line = runLine({ ...RUN, query }, 'A')
    expect(line).toContain('~')
    expect(line).not.toContain(homedir())
    expect(withoutHomePaths(homedir().split('\\').join('/'))).toBe('~')
  })
})
