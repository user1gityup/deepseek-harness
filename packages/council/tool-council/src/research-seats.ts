/** Distribute research queries across enabled free seats with native web tools. */
import type { SearchSeam, EvidenceSource } from './evidence.ts'
import type { SeatConfig, SeatReply } from './seats.ts'

/**
 * Create a round-robin search provider, falling back to the host on failure.
 * @param seats - active seats in this run.
 * @param ask - accounted seat invocation owned by the council run.
 * @param fallback - existing search provider, when mounted.
 * @returns a search provider, or the original fallback when no free seat can search.
 */
export function researchSeats(
  seats: readonly SeatConfig[],
  ask: (seat: SeatConfig, prompt: string) => Promise<SeatReply>,
  fallback: SearchSeam | undefined,
): SearchSeam | undefined {
  const workers = seats.filter(seat => seat.enabled && seat.free === true && seat.nativeWebSearch === true)
  if (workers.length === 0) return fallback
  let next = 0
  return {
    async search(request, signal) {
      signal?.throwIfAborted()
      const seat = workers[next % workers.length]
      next += 1
      try {
        // `workers` is non-empty - the early return above guarantees it - so this
        // index always resolves. The explicit guard is what satisfies
        // noUncheckedIndexedAccess without a forbidden non-null assertion, and it
        // routes through the same catch that falls back to the host provider.
        if (seat === undefined) throw new Error('no research seat available')
        const reply = await ask(seat, `Search the web for the query below using your web tools. Do not read or modify project files.
Return only JSON: {"sources":[{"url":"https://...","title":"...","snippet":"..."}]}.
Include at most ${String(request.maxResults ?? 6)} sources you actually consulted. Do not invent URLs or facts.
QUERY: ${request.query}`)
        if (reply.error !== undefined) throw new Error(reply.error)
        const body = JSON.parse(reply.text.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\s*\x60\x60\x60$/, '')) as { sources?: unknown }
        if (!Array.isArray(body.sources)) throw new Error('search reply contains no sources')
        const sources: EvidenceSource[] = []
        for (const item of body.sources) {
          if (typeof item !== 'object' || item === null) continue
          const row = item as Record<string, unknown>
          if (typeof row.url !== 'string') continue
          let url: URL
          try { url = new URL(row.url) } catch { continue /* malformed model-produced URL */ }
          if (url.protocol !== 'https:' && url.protocol !== 'http:') continue
          sources.push({ url: url.href, ...(typeof row.title === 'string' ? { title: row.title } : {}), ...(typeof row.snippet === 'string' ? { snippet: row.snippet } : {}) })
        }
        if (sources.length === 0) throw new Error('search reply contains no usable sources')
        return { sources: sources.slice(0, request.maxResults ?? 6) }
      } catch (error) {
        signal?.throwIfAborted()
        if (fallback !== undefined) return fallback.search(request, signal)
        throw error
      }
    },
  }
}
