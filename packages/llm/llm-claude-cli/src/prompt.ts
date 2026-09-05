/**
 * Flattening harness messages into the single prompt string a `claude -p` run
 * accepts.
 *
 * The CLI's print mode takes one prompt and returns one answer: there is no
 * multi-turn request body to fill. So history has to be rendered into the
 * prompt itself, and the rendering has to be unambiguous enough that the model
 * can tell its own previous words from the user's. Labelled turns do that at
 * the cost of a few tokens per message, which is far cheaper than the model
 * mistaking transcript for instruction.
 *
 * A single user turn is passed through verbatim. That is the common case, and
 * wrapping it would put framing around a prompt that never needed any.
 * @module @deepseek-ai/dsh-llm-claude-cli/prompt
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'

/** Render one content block as the text the CLI will see. */
function renderBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'reasoning':
      // Prior thinking is context, not instruction, and is marked as such.
      return `[thinking] ${block.text}`
    case 'tool-call':
      return `[tool call ${block.name} ${block.arguments}]`
    case 'tool-result': {
      const inner = block.content.map(renderBlock).join('\n')
      return block.isError === true ? `[tool error]\n${inner}` : `[tool result]\n${inner}`
    }
    case 'image':
      // Print mode takes no inline images; naming the omission beats a silent gap.
      return '[image omitted: the Claude CLI adapter sends text only]'
    default:
      return ''
  }
}

/** Render one message's blocks, dropping the ones that produced nothing. */
function renderMessage(message: Message): string {
  return message.content.map(renderBlock).filter(text => text !== '').join('\n')
}

/** The turn label used for each role in a rendered transcript. */
const ROLE_LABEL: Readonly<Record<Message['role'], string>> = {
  system: 'System',
  user: 'User',
  assistant: 'Assistant',
}

/**
 * Build the prompt argument for one request.
 *
 * @param messages - the conversation as the provider would see it.
 * @returns one prompt string; empty when nothing renderable was supplied.
 */
export function buildPrompt(messages: readonly Message[]): string {
  const rendered = messages
    .map(message => ({ role: message.role, text: renderMessage(message) }))
    .filter(turn => turn.text !== '')
  if (rendered.length === 0) return ''
  const only = rendered[0]
  if (rendered.length === 1 && only !== undefined && only.role === 'user') return only.text
  return rendered.map(turn => `${ROLE_LABEL[turn.role]}: ${turn.text}`).join('\n\n')
}
