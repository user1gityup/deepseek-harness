import { describe, expect, it } from 'vitest'
import { gatherEvidence } from '../src/evidence.ts'
import type { EvidenceSource, SearchSeam } from '../src/evidence.ts'

/** A seam returning a fixed set of sources. */
function seam(sources: readonly EvidenceSource[], content?: string): SearchSeam {
  return {
    async search() {
      return content === undefined ? { sources } : { content, sources }
    },
  }
}

describe('gatherEvidence', () => {
  it('returns undefined when the host mounts no seam', async () => {
    expect(await gatherEvidence(undefined, 'anything')).toBeUndefined()
  })

  it('returns undefined rather than throwing when the provider fails', async () => {
    const failing: SearchSeam = {
      async search() { throw new Error('WEB_PROVIDER_AMBIGUOUS') },
    }
    // A council that cannot search is degraded, not broken.
    expect(await gatherEvidence(failing, 'anything')).toBeUndefined()
  })

  it('returns undefined when the search finds nothing', async () => {
    expect(await gatherEvidence(seam([]), 'anything')).toBeUndefined()
  })

  it('numbers sources so a seat can cite them by index', async () => {
    const evidence = await gatherEvidence(seam([
      { url: 'https://a.example/one', title: 'First', snippet: 'alpha' },
      { url: 'https://b.example/two', title: 'Second', snippet: 'beta' },
    ]), 'q')
    expect(evidence).toBeDefined()
    expect(evidence?.block).toContain('[1] First — https://a.example/one')
    expect(evidence?.block).toContain('[2] Second — https://b.example/two')
    expect(evidence?.urls).toEqual(['https://a.example/one', 'https://b.example/two'])
  })

  it('tells the seat the evidence outranks its training data', async () => {
    const evidence = await gatherEvidence(seam([{ url: 'https://a.example' }]), 'q')
    expect(evidence?.block).toContain('your training data is not')
  })

  it('falls back to the bare url when a source has no title', async () => {
    const evidence = await gatherEvidence(seam([{ url: 'https://bare.example' }]), 'q')
    expect(evidence?.block).toContain('[1] https://bare.example')
  })

  it('collapses and caps a long snippet so one source cannot dominate', async () => {
    const evidence = await gatherEvidence(seam([
      { url: 'https://a.example', snippet: `${'x'.repeat(900)}\n\nmore   text` },
    ]), 'q')
    expect(evidence?.block).toContain('...')
    expect(evidence?.block).not.toContain('\n\nmore   text')
  })

  it('includes a provider summary when one is offered', async () => {
    const evidence = await gatherEvidence(
      seam([{ url: 'https://a.example' }], 'the provider said this'),
      'q',
    )
    expect(evidence?.block).toContain('the provider said this')
  })
})
