/**
 * Flattening harness messages into the one prompt Antigravity's agent accepts,
 * inside the length it can carry.
 *
 * The driver hands the prompt to `agentapi` as a single argv entry, and Windows
 * caps a whole command line at 32767 characters; the driver refuses anything
 * over 30000 once its own policy preamble is added. A main-agent turn carries
 * the whole conversation, so a long session would otherwise stop answering
 * outright. Instead the prompt is fitted: the system prompt keeps its opening
 * (at most half the budget), and the newest turns are kept whole for as long as
 * they fit, with a marker naming how many older turns were left out.
 *
 * A single user turn with no system prompt is passed through verbatim, as the
 * Claude CLI adapter does: wrapping it would frame a prompt that needs none.
 * @module @deepseek-ai/dsh-llm-antigravity/prompt
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'

/** Between rendered turns. */
const SEPARATOR = '\n\n'
/** Room kept for the omission marker, which is written after the turns are chosen. */
const MARKER_RESERVE = 96
const HEAD_CUT = '\n[… system prompt truncated to fit Antigravity’s prompt limit]'
const TAIL_CUT = '[… start of this turn truncated to fit Antigravity’s prompt limit]\n'

/** Render one content block as the text the agent will see. */
function renderBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'reasoning':
      return `[thinking] ${block.text}`
    case 'tool-call':
      return `[tool call ${block.name} ${block.arguments}]`
    case 'tool-result': {
      const inner = block.content.map(renderBlock).join('\n')
      return block.isError === true ? `[tool error]\n${inner}` : `[tool result]\n${inner}`
    }
    case 'image':
      return '[image omitted: the Antigravity adapter sends text only]'
    default:
      return ''
  }
}

function renderMessage(message: Message): string {
  return message.content.map(renderBlock).filter(text => text !== '').join('\n')
}

const ROLE_LABEL: Readonly<Record<Message['role'], string>> = {
  system: 'System',
  user: 'User',
  assistant: 'Assistant',
}

/** Keep the start of `text` within `limit` characters. */
function keepHead(text: string, limit: number): string {
  if (text.length <= limit) return text
  if (limit <= HEAD_CUT.length) return text.slice(0, Math.max(0, limit))
  return text.slice(0, limit - HEAD_CUT.length) + HEAD_CUT
}

/** Keep the end of `text` within `limit` characters. */
function keepTail(text: string, limit: number): string {
  if (text.length <= limit) return text
  if (limit <= TAIL_CUT.length) return limit > 0 ? text.slice(-limit) : ''
  return TAIL_CUT + text.slice(text.length - (limit - TAIL_CUT.length))
}

/** A fitted prompt and what fitting cost. */
export interface BuiltPrompt {
  /** The prompt; empty when nothing renderable was supplied. */
  readonly text: string
  /** Older turns left out entirely. */
  readonly omittedTurns: number
  /** Whether the system prompt or the newest turn was cut. */
  readonly clipped: boolean
}

/**
 * Build the prompt for one request.
 * @param messages - the conversation as the provider would see it.
 * @param system - the request's system prompt, if any.
 * @param budget - the most characters the prompt may hold.
 * @returns the fitted prompt.
 */
export function buildPrompt(messages: readonly Message[], system: string | undefined, budget: number): BuiltPrompt {
  const turns = messages
    .map(message => ({ role: message.role, text: renderMessage(message) }))
    .filter(turn => turn.text !== '')
  const head = system?.trim() ?? ''
  if (turns.length === 0 && head === '') return { text: '', omittedTurns: 0, clipped: false }
  const only = turns[0]
  if (head === '' && turns.length === 1 && only !== undefined && only.role === 'user') {
    const text = keepTail(only.text, budget)
    return { text, omittedTurns: 0, clipped: text !== only.text }
  }

  let clipped = false
  let systemText = head === '' ? '' : `${ROLE_LABEL.system}: ${head}`
  if (systemText.length > Math.floor(budget / 2)) {
    systemText = keepHead(systemText, Math.floor(budget / 2))
    clipped = true
  }

  const rendered = turns.map(turn => `${ROLE_LABEL[turn.role]}: ${turn.text}`)
  const kept: string[] = []
  let used = systemText.length
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const turn = rendered[index]
    if (turn === undefined) continue
    const cost = turn.length + SEPARATOR.length
    if (used + cost + MARKER_RESERVE <= budget) {
      kept.unshift(turn)
      used += cost
      continue
    }
    // The newest turn is what the agent is being asked to answer, so it is
    // never dropped: it is cut to what is left, keeping its end.
    if (kept.length === 0) {
      kept.unshift(keepTail(turn, budget - used - SEPARATOR.length - MARKER_RESERVE))
      clipped = true
    }
    break
  }
  const omittedTurns = rendered.length - kept.length
  const marker = omittedTurns > 0
    ? `[${String(omittedTurns)} earlier turn${omittedTurns === 1 ? '' : 's'} omitted to fit Antigravity’s prompt limit]`
    : ''
  const text = [systemText, marker, ...kept].filter(part => part !== '').join(SEPARATOR)
  return { text: keepTail(text, budget), omittedTurns, clipped }
}
