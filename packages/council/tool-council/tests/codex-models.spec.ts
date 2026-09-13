import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readCodexModels } from '../src/codex-models.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Write a cache file and return its path. */
function cache(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-models-'))
  dirs.push(dir)
  const file = join(dir, 'models_cache.json')
  writeFileSync(file, body)
  return file
}

describe('readCodexModels', () => {
  it('lists the models Codex shows, in cache order, without hidden ones', () => {
    const file = cache(JSON.stringify({
      models: [
        { slug: 'gpt-5.6-sol', visibility: 'list' },
        { slug: 'gpt-reserve', visibility: 'hide' },
        { slug: 'gpt-5.5', visibility: 'list' },
        { slug: 'gpt-5.5', visibility: 'list' },
        { display_name: 'no slug' },
      ],
    }))
    expect(readCodexModels(file)).toEqual(['gpt-5.6-sol', 'gpt-5.5'])
  })

  it('offers nothing when the cache is missing or malformed', () => {
    expect(readCodexModels(join(tmpdir(), 'no-such-dir', 'models_cache.json'))).toEqual([])
    expect(readCodexModels(cache('{not json'))).toEqual([])
    expect(readCodexModels(cache('{"models": 3}'))).toEqual([])
  })
})
