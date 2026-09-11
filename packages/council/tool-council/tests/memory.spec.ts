import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Config, resolveMemory } from '../src/index.ts'

/**
 * Shared memory for seats: the agent-memory digest, and the user's shared brain
 * index ahead of it. Every seat, CLI or hosted, must see the same text.
 */
describe('resolveMemory', () => {
  let root: string
  let digest: string
  let brain: string
  let previousHome: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'council-memory-'))
    previousHome = process.env['DSH_HOME']
    process.env['DSH_HOME'] = join(root, 'dsh')
    mkdirSync(join(root, 'dsh', 'memory'), { recursive: true })
    mkdirSync(join(root, 'brain'), { recursive: true })
    digest = join(root, 'dsh', 'memory', 'digest.md')
    brain = join(root, 'brain', 'MEMORY.md')
    writeFileSync(digest, '# Shared agent memory\n\n## fact\n\n- The council runs a planning round first.\n')
    writeFileSync(brain, '## Standing policy\r\n- [Fix, do not explain](fix-dont-explain.md) - apply fixes silently\r\n')
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previousHome
    rmSync(root, { recursive: true, force: true })
  })

  it('puts the brain index ahead of the digest, in one file every seat reads', () => {
    const memory = resolveMemory(digest, brain)
    const file = join(root, 'dsh', 'memory', 'council-context.md')
    expect(memory?.file).toBe(file)
    expect(memory?.text).toBe(readFileSync(file, 'utf8'))
    const text = memory?.text ?? ''
    expect(text.startsWith('# Shared brain\n')).toBe(true)
    expect(text).toContain(`(${join(root, 'brain').split('\\').join('/')})`)
    expect(text).toContain('- [Fix, do not explain](fix-dont-explain.md)')
    expect(text).not.toContain('\r')
    expect(text.indexOf('fix-dont-explain.md')).toBeLessThan(text.indexOf('planning round first'))
  })

  it('carries the brain alone when there is no useful digest', () => {
    writeFileSync(digest, '# Shared agent memory\n\n_No memories recorded yet._\n')
    const placeholder = resolveMemory(digest, brain)?.text ?? ''
    expect(placeholder).toContain('fix-dont-explain.md')
    expect(placeholder).not.toContain('No memories recorded yet')
    expect(placeholder).not.toContain('---')

    rmSync(digest)
    expect(resolveMemory(undefined, brain)?.text).toContain('fix-dont-explain.md')
    expect(resolveMemory(false, brain)?.text).toContain('fix-dont-explain.md')
  })

  it('keeps the digest-only behaviour when the brain is off or absent', () => {
    expect(resolveMemory(digest, false)).toEqual({ file: digest, text: readFileSync(digest, 'utf8') })
    expect(resolveMemory(digest, join(root, 'nowhere', 'MEMORY.md'))).toEqual({ file: digest, text: readFileSync(digest, 'utf8') })
    expect(existsSync(join(root, 'dsh', 'memory', 'council-context.md'))).toBe(false)
    expect(resolveMemory(join(root, 'missing.md'), false)).toBeUndefined()
    expect(resolveMemory(false, false)).toBeUndefined()
  })

  it('accepts brainIndex in settings without inventing a default', () => {
    expect(Config({}).brainIndex).toBeUndefined()
    expect(Config({ brainIndex: false }).brainIndex).toBe(false)
    expect(Config({ brainIndex: 'C:/brain/MEMORY.md' }).brainIndex).toBe('C:/brain/MEMORY.md')
  })
})
