/**
 * Shared evidence for the drafting round.
 *
 * Only CLI seats carry tools. An OpenRouter seat is a bare chat completion —
 * no search, no fetch, no filesystem — so asked for something specific and
 * current it cannot know, it will often emit tool-call syntax it has no way to
 * execute and then report training data as though it had been verified. The
 * seat is not being dishonest; nothing ever told it the tools were absent.
 *
 * Rather than buy every seat its own metered search, the council runs one
 * search through the harness web seam, whose router prefers a route already
 * paid for by subscription, and hands the same sources to every seat. One
 * search, shared evidence, and no seat needs to invent a citation.
 */

/** One retrieved source. Mirrors the web seam's shape, structurally. */
export interface EvidenceSource {
  readonly url: string
  readonly title?: string | undefined
  readonly snippet?: string | undefined
  readonly publishedAt?: string | undefined
}

/** The subset of the web seam this module needs, so tests need no host. */
export interface SearchSeam {
  search(
    request: { readonly query: string; readonly maxResults?: number },
    signal?: AbortSignal,
  ): Promise<{ readonly content?: string | undefined; readonly sources: readonly EvidenceSource[] }>
}

/** Retrieved evidence, ready to paste into a prompt. */
export interface Evidence {
  /** Prompt-ready block, numbered so seats can cite by index. */
  readonly block: string
  /** Source URLs in citation order, for later verification. */
  readonly urls: readonly string[]
}

/** Sources retrieved per run. Enough to ground an answer, few enough to stay cheap. */
const MAX_RESULTS = 6
/** Snippets are truncated so evidence never crowds out the question itself. */
const SNIPPET_LIMIT = 400

/**
 * Collapse whitespace and cap length, so one verbose source cannot dominate.
 * @param text - raw snippet text.
 * @returns a single-line, length-capped snippet.
 */
function tidy(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= SNIPPET_LIMIT ? flat : `${flat.slice(0, SNIPPET_LIMIT)}...`
}

/**
 * Render retrieved sources as a numbered, citable block.
 * @param sources - what the seam returned.
 * @param summary - optional provider-written summary.
 * @returns the prompt block.
 */
function render(sources: readonly EvidenceSource[], summary: string | undefined): string {
  const lines: string[] = [
    'EVIDENCE — retrieved from the web moments ago, for this question.',
    '',
    'This is current and your training data is not. Where the two disagree, the evidence wins.',
    '',
  ]
  if (summary !== undefined && summary.trim() !== '') {
    lines.push(`Summary from the search provider: ${tidy(summary)}`, '')
  }
  sources.forEach((source, index) => {
    const label = source.title === undefined || source.title.trim() === ''
      ? source.url
      : `${source.title.trim()} — ${source.url}`
    lines.push(`[${String(index + 1)}] ${label}`)
    if (source.publishedAt !== undefined && source.publishedAt.trim() !== '') {
      lines.push(`    published: ${source.publishedAt.trim()}`)
    }
    if (source.snippet !== undefined && source.snippet.trim() !== '') {
      lines.push(`    ${tidy(source.snippet)}`)
    }
  })
  lines.push(
    '',
    'Cite these by their number. If the evidence does not settle something, say so plainly rather than filling the gap from memory.',
  )
  return lines.join('\n')
}

/**
 * Run one search and render it as shared evidence.
 *
 * Failure is not fatal: a council that cannot search is still a council, and a
 * seat told plainly that no evidence was retrieved behaves far better than one
 * left to guess whether it has tools. Returns undefined so the caller can say
 * exactly that.
 * @param seam - the web seam, or undefined when the host mounts none.
 * @param query - the user's question.
 * @param signal - cancellation from the run.
 * @returns the evidence, or undefined when nothing could be retrieved.
 */
export async function gatherEvidence(
  seam: SearchSeam | undefined,
  query: string,
  signal?: AbortSignal,
): Promise<Evidence | undefined> {
  if (seam === undefined) return undefined
  let sources: readonly EvidenceSource[]
  let summary: string | undefined
  try {
    const result = await seam.search({ query, maxResults: MAX_RESULTS }, signal)
    sources = result.sources
    summary = result.content
  } catch {
    // An unavailable or ambiguous provider is a degraded run, not a failed one.
    return undefined
  }
  if (sources.length === 0) return undefined
  return { block: render(sources, summary), urls: sources.map(source => source.url) }
}
