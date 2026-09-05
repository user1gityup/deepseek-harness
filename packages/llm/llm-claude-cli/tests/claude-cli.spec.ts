import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { buildArgs, classifyFailure, DEFAULT_CONTEXT_WINDOW, DEFAULT_TIMEOUT_MS } from '../src/adapter.ts'
import type { ClaudeCliOptions } from '../src/adapter.ts'
import { drainLines, parseLine, readUsage } from '../src/events.ts'
import { executableCandidates, isWrongSpelling } from '../src/executable.ts'
import { buildPrompt } from '../src/prompt.ts'
import { Config, resolveOptions } from '../src/index.ts'

/** A message with only the fields these pure functions read. */
function message(role: Message['role'], text: string): Message {
  return { id: `m-${role}-${text}`, role, content: [{ type: 'text', text }], source: {} } as unknown as Message
}

const OPTIONS: ClaudeCliOptions = {
  command: 'claude',
  timeoutMs: DEFAULT_TIMEOUT_MS,
  defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
  safeMode: true,
  tools: '',
}

const REQUEST = { provider: 'claude-cli', model: 'opus', messages: [] } as unknown as GenerateOptions

describe('buildPrompt', () => {
  it('passes a lone user turn through without framing', () => {
    expect(buildPrompt([message('user', 'what changed?')])).toBe('what changed?')
  })

  it('labels turns once there is history to disambiguate', () => {
    const prompt = buildPrompt([
      message('user', 'first'),
      message('assistant', 'second'),
      message('user', 'third'),
    ])
    expect(prompt).toBe('User: first\n\nAssistant: second\n\nUser: third')
  })

  it('drops messages that render to nothing', () => {
    expect(buildPrompt([message('user', 'kept'), message('assistant', '')])).toBe('kept')
  })

  it('returns empty for a request with no renderable content', () => {
    expect(buildPrompt([])).toBe('')
  })

  it('marks an image as omitted rather than dropping it silently', () => {
    const withImage = {
      id: 'm1',
      role: 'user',
      content: [{ type: 'image', attachment: {} }],
      source: {},
    } as unknown as Message
    expect(buildPrompt([withImage])).toContain('image omitted')
  })

  it('renders a tool result so history stays coherent', () => {
    const withResult = {
      id: 'm1',
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }],
      source: {},
    } as unknown as Message
    expect(buildPrompt([withResult])).toBe('[tool result]\nok')
  })
})

describe('parseLine', () => {
  it('reads a text delta out of a stream_event', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
    })
    expect(parseLine(line)).toEqual({ kind: 'delta', channel: 'text', text: 'hi' })
  })

  it('reads a thinking delta as reasoning', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
    })
    expect(parseLine(line)).toEqual({ kind: 'delta', channel: 'reasoning', text: 'hmm' })
  })

  it('reads a complete assistant message', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'thinking', thinking: 'a' }, { type: 'text', text: 'b' }],
        usage: { input_tokens: 3, output_tokens: 4 },
      },
    })
    expect(parseLine(line)).toEqual({
      kind: 'assistant',
      text: 'b',
      reasoning: 'a',
      usage: { inputTokens: 3, outputTokens: 4 },
    })
  })

  it('reads a successful result', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', result: 'done', usage: { output_tokens: 2 } })
    expect(parseLine(line)).toEqual({
      kind: 'result',
      text: 'done',
      isError: false,
      usage: { inputTokens: 0, outputTokens: 2 },
    })
  })

  it('treats a non-success subtype as a failure', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'error_during_execution', result: '' })
    expect(parseLine(line)).toMatchObject({ kind: 'result', isError: true, failure: 'error_during_execution' })
  })

  it('ignores noise, unknown events, and malformed JSON', () => {
    expect(parseLine('')).toBeUndefined()
    expect(parseLine('Warning: something')).toBeUndefined()
    expect(parseLine('{"type":"system","subtype":"init"}')).toBeUndefined()
    expect(parseLine('{"type":"result"')).toBeUndefined()
  })
})

describe('readUsage', () => {
  it('keeps cache counts separate from uncached input', () => {
    expect(readUsage({
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
    })).toEqual({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 })
  })

  it('returns undefined when the line carried no counts', () => {
    expect(readUsage(undefined)).toBeUndefined()
    expect(readUsage({ input_tokens: 0, output_tokens: 0 })).toBeUndefined()
  })
})

describe('drainLines', () => {
  it('holds back a line that has not been terminated yet', () => {
    const first = drainLines('{"type":"result","subtype":"success","result":"a"}\n{"type":"resu')
    expect(first.events).toHaveLength(1)
    expect(first.rest).toBe('{"type":"resu')
    const second = drainLines(`${first.rest}lt","subtype":"success","result":"b"}\n`)
    expect(second.events).toEqual([{ kind: 'result', text: 'b', isError: false }])
  })
})

describe('buildArgs', () => {
  it('asks for streaming json with no built-in tools', () => {
    const args = buildArgs(OPTIONS, REQUEST, 'hello')
    expect(args).toContain('--print')
    expect(args.join(' ')).toContain('--output-format stream-json')
    expect(args.join(' ')).toContain('--tools ')
    expect(args).toContain('--safe-mode')
    expect(args.at(-1)).toBe('hello')
  })

  it('passes the system slot through and keeps the prompt last', () => {
    const args = buildArgs(OPTIONS, { ...REQUEST, system: 'be brief' }, 'hello')
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('be brief')
    expect(args.at(-1)).toBe('hello')
  })

  it('omits safe mode when it is turned off', () => {
    expect(buildArgs({ ...OPTIONS, safeMode: false }, REQUEST, 'hello')).not.toContain('--safe-mode')
  })
})

describe('classifyFailure', () => {
  it('routes the failures retry policy treats differently', () => {
    expect(classifyFailure('Claude usage limit reached')).toBe('RATE_LIMIT')
    expect(classifyFailure('Please log in with /login')).toBe('AUTH')
    expect(classifyFailure('API Error: 529 Overloaded')).toBe('SERVER')
    expect(classifyFailure('something else entirely')).toBe('TRANSPORT')
  })
})

describe('executableCandidates', () => {
  it('offers the bare name off Windows and tries spellings on it', () => {
    const candidates = executableCandidates('claude')
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.some(entry => entry.includes('claude'))).toBe(true)
    if (process.platform === 'win32') expect(candidates.some(entry => entry.endsWith('.exe'))).toBe(true)
    else expect(candidates).toEqual(['claude'])
  })

  it('recognises the spawn errors that mean "try the next spelling"', () => {
    expect(isWrongSpelling('spawn claude ENOENT')).toBe(true)
    expect(isWrongSpelling('spawn EINVAL')).toBe(true)
    expect(isWrongSpelling('EACCES: permission denied')).toBe(false)
  })
})

describe('config', () => {
  it('resolves an empty config without materialising a broken default', () => {
    expect(() => Config({})).not.toThrow()
    expect(resolveOptions(Config({}))).toEqual({
      command: 'claude',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
      safeMode: true,
      tools: '',
    })
  })

  it('falls back to the default command for a blank one', () => {
    expect(resolveOptions({ command: '   ' }).command).toBe('claude')
  })

  it('refuses bounds a running settings document could not survive', () => {
    expect(() => resolveOptions({ timeoutMs: 10 })).toThrow(/timeoutMs/)
    expect(() => resolveOptions({ defaultContextWindow: 10 })).toThrow(/defaultContextWindow/)
  })
})
