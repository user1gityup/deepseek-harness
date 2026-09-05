/**
 * Reading the CLI's `stream-json` output.
 *
 * This is a wire format owned by another program and versioned on its own
 * schedule, so every field is treated as absent until proven otherwise and an
 * unrecognised line is dropped rather than raised. The adapter's contract with
 * the harness must not depend on the CLI keeping any particular event shape:
 * losing a delta degrades streaming, while the terminal `result` line still
 * carries the whole answer.
 * @module @deepseek-ai/dsh-llm-claude-cli/events
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** What one interesting output line meant. */
export type CliEvent =
  /** Incremental content, available only with `--include-partial-messages`. */
  | { kind: 'delta'; channel: 'text' | 'reasoning'; text: string }
  /** One complete assistant message; the fallback when no deltas arrived. */
  | { kind: 'assistant'; text: string; reasoning: string; usage?: TokenUsage }
  /** The terminal line: the whole answer, the run's usage, and its status. */
  | { kind: 'result'; text: string; isError: boolean; usage?: TokenUsage; failure?: string }

/** Narrow an unknown to an index signature without asserting any field exists. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Read a field only when it is actually a string. */
function str(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key]
  return typeof value === 'string' ? value : undefined
}

/** Read a field only when it is a finite non-negative number. */
function count(source: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = source?.[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Map the CLI's usage object onto the harness vocabulary.
 *
 * The counts line up directly: Anthropic already reports uncached input
 * separately from cache reads and writes, which is the disjointness
 * {@link TokenUsage} requires, so nothing is subtracted here.
 * @param source - the `usage` value from an assistant or result line.
 * @returns harness usage, or undefined when the line carried none.
 */
export function readUsage(source: unknown): TokenUsage | undefined {
  const usage = asRecord(source)
  if (usage === undefined) return undefined
  const inputTokens = count(usage, 'input_tokens') ?? 0
  const outputTokens = count(usage, 'output_tokens') ?? 0
  const cacheReadTokens = count(usage, 'cache_read_input_tokens')
  const cacheWriteTokens = count(usage, 'cache_creation_input_tokens')
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === undefined && cacheWriteTokens === undefined) {
    return undefined
  }
  return {
    inputTokens,
    outputTokens,
    ...cacheReadTokens === undefined ? {} : { cacheReadTokens },
    ...cacheWriteTokens === undefined ? {} : { cacheWriteTokens },
  }
}

/** Pull the text and thinking halves out of a complete message's content array. */
function readContent(message: Record<string, unknown> | undefined): { text: string; reasoning: string } {
  const content = message?.['content']
  if (!Array.isArray(content)) return { text: '', reasoning: '' }
  const text: string[] = []
  const reasoning: string[] = []
  for (const entry of content) {
    const block = asRecord(entry)
    const type = str(block, 'type')
    if (type === 'text') {
      const value = str(block, 'text')
      if (value !== undefined) text.push(value)
    } else if (type === 'thinking') {
      const value = str(block, 'thinking')
      if (value !== undefined) reasoning.push(value)
    }
  }
  return { text: text.join(''), reasoning: reasoning.join('') }
}

/** Turn one `stream_event` envelope into a delta, when it carries content. */
function readStreamEvent(event: Record<string, unknown> | undefined): CliEvent | undefined {
  if (str(event, 'type') !== 'content_block_delta') return undefined
  const delta = asRecord(event?.['delta'])
  const type = str(delta, 'type')
  if (type === 'text_delta') {
    const text = str(delta, 'text')
    return text === undefined || text === '' ? undefined : { kind: 'delta', channel: 'text', text }
  }
  if (type === 'thinking_delta') {
    const text = str(delta, 'thinking')
    return text === undefined || text === '' ? undefined : { kind: 'delta', channel: 'reasoning', text }
  }
  return undefined
}

/**
 * Interpret one NDJSON line.
 * @param line - one raw line of the CLI's stdout.
 * @returns the event it described, or undefined for noise and unknown shapes.
 */
export function parseLine(line: string): CliEvent | undefined {
  const trimmed = line.trim()
  if (trimmed === '' || !trimmed.startsWith('{')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // A partial or non-JSON line is noise, not a failure: the terminal
    // `result` line still carries the whole answer.
    return undefined
  }
  const root = asRecord(parsed)
  const type = str(root, 'type')
  if (type === 'stream_event') return readStreamEvent(asRecord(root?.['event']))
  if (type === 'assistant') {
    const message = asRecord(root?.['message'])
    const { text, reasoning } = readContent(message)
    const usage = readUsage(message?.['usage'])
    if (text === '' && reasoning === '' && usage === undefined) return undefined
    return { kind: 'assistant', text, reasoning, ...usage === undefined ? {} : { usage } }
  }
  if (type === 'result') {
    const subtype = str(root, 'subtype')
    const isError = root?.['is_error'] === true || (subtype !== undefined && subtype !== 'success')
    const usage = readUsage(root?.['usage'])
    const failure = str(root, 'error') ?? (isError ? subtype : undefined)
    return {
      kind: 'result',
      text: str(root, 'result') ?? '',
      isError,
      ...usage === undefined ? {} : { usage },
      ...failure === undefined ? {} : { failure },
    }
  }
  return undefined
}

/**
 * Split a growing stdout buffer into whole lines.
 *
 * Returns the parsed events plus whatever tail has not yet been terminated by a
 * newline, so the caller can prepend it to the next chunk. A JSON object split
 * across two reads is common at these sizes and must not be parsed twice.
 * @param buffer - accumulated text that has not been consumed yet.
 * @returns the events found and the unconsumed remainder.
 */
export function drainLines(buffer: string): { events: CliEvent[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  const events: CliEvent[] = []
  for (const part of parts) {
    const event = parseLine(part)
    if (event !== undefined) events.push(event)
  }
  return { events, rest }
}
