import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  AntigravityAdapter, buildArgs, classifyFailure, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_PROMPT_CHARS, DEFAULT_TIMEOUT_MS,
  failureLine, parseDriverOutput,
} from '../src/adapter.ts'
import type { AntigravityOptions } from '../src/adapter.ts'
import { buildPrompt } from '../src/prompt.ts'
import { resolveOptions } from '../src/index.ts'

function message(role: Message['role'], text: string): Message {
  return { id: `m-${role}-${text.slice(0, 8)}`, role, content: [{ type: 'text', text }], source: {} } as unknown as Message
}

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
}

const OPTIONS: AntigravityOptions = {
  driver: fixture('driver-ok.mjs'),
  seat: 'auto',
  tools: 'shared',
  timeoutMs: DEFAULT_TIMEOUT_MS,
  defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
  maxPromptChars: DEFAULT_MAX_PROMPT_CHARS,
}

async function collect(adapter: AntigravityAdapter, request: Partial<GenerateOptions>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({ provider: 'antigravity', model: 'flash', messages: [], ...request } as unknown as GenerateOptions)) {
    chunks.push(chunk)
  }
  return chunks
}

describe('buildPrompt', () => {
  it('passes a lone user turn through without framing', () => {
    expect(buildPrompt([message('user', 'what changed?')], undefined, 1000)).toEqual({ text: 'what changed?', omittedTurns: 0, clipped: false })
  })

  it('labels the system prompt and turns once there is more than one part', () => {
    const prompt = buildPrompt([message('user', 'first'), message('assistant', 'second'), message('user', 'third')], 'Be brief.', 1000)
    expect(prompt.text).toBe('System: Be brief.\n\nUser: first\n\nAssistant: second\n\nUser: third')
  })

  it('drops the oldest turns to fit, names how many, and stays inside the budget', () => {
    const turns = Array.from({ length: 30 }, (_, index) => message(index % 2 === 0 ? 'user' : 'assistant', `turn ${String(index)} ${'x'.repeat(200)}`))
    const prompt = buildPrompt(turns, 'System rules.', 2000)
    expect(prompt.text.length).toBeLessThanOrEqual(2000)
    expect(prompt.omittedTurns).toBeGreaterThan(0)
    expect(prompt.text).toContain(`[${String(prompt.omittedTurns)} earlier turns omitted`)
    expect(prompt.text.startsWith('System: System rules.')).toBe(true)
    expect(prompt.text.endsWith(`turn 29 ${'x'.repeat(200)}`)).toBe(true)
  })

  it('caps the system prompt at half the budget and keeps the end of an oversized newest turn', () => {
    const prompt = buildPrompt([message('user', `${'a'.repeat(5000)}QUESTION`)], 's'.repeat(5000), 2000)
    expect(prompt.clipped).toBe(true)
    expect(prompt.text.length).toBeLessThanOrEqual(2000)
    expect(prompt.text).toContain('system prompt truncated')
    expect(prompt.text.endsWith('QUESTION')).toBe(true)
  })

  it('returns empty for a request with nothing renderable', () => {
    expect(buildPrompt([], undefined, 1000).text).toBe('')
  })
})

describe('driver protocol', () => {
  it('asks for JSON on the configured seat, tier and policy', () => {
    expect(buildArgs({ ...OPTIONS, driver: 'agy.mjs', seat: 'fam1', tools: 'web', timeoutMs: 5000 }, 'pro'))
      .toEqual(['agy.mjs', '--model', 'pro', '--tools', 'web', '--seat', 'fam1', '--timeout', '5000', '--title', 'DSH', '--json'])
  })

  it('reads the last JSON result line', () => {
    expect(parseDriverOutput('chatter\n{"text":"first"}\n{"text":"answer","seat":"seat1"}\n')).toBe('answer')
    expect(parseDriverOutput('no result')).toBeUndefined()
  })

  it('classifies pool failures without mistaking a failed quota check for exhaustion', () => {
    expect(classifyFailure('no pool seat could answer. seat1 (quota): RESOURCE_EXHAUSTED')).toBe('RATE_LIMIT')
    expect(classifyFailure('no pool seat could answer. seat1: quota check failed: fetch failed')).toBe('TRANSPORT')
    expect(classifyFailure('seat fam1 failed (signed-out)')).toBe('AUTH')
    expect(classifyFailure('timed out after 420000ms waiting for conversation x')).toBe('TIMEOUT')
    expect(failureLine('noise\nagy-headless: no pool seat could answer\ntrailing')).toBe('no pool seat could answer')
  })

  it('resolves defaults and refuses a policy the driver does not know', () => {
    expect(resolveOptions({})).toMatchObject({ seat: 'auto', tools: 'shared', timeoutMs: 420_000, maxPromptChars: 28_000 })
    expect(resolveOptions({}).driver).toMatch(/agy-headless\.mjs$/)
    expect(() => resolveOptions({ tools: 'none' })).toThrow('tools')
  })
})

describe('AntigravityAdapter', () => {
  it('streams the driver answer as one text block, sending the prompt on stdin', async () => {
    const warnings: string[] = []
    const adapter = new AntigravityAdapter({ options: () => OPTIONS, onUnsupportedTools: (text) => { warnings.push(text) } })
    const chunks = await collect(adapter, {
      model: 'pro',
      system: 'Be brief.',
      messages: [message('user', 'hello'), message('assistant', 'hi'), message('user', 'bye')],
      tools: [{ name: 'read' }],
    } as unknown as Partial<GenerateOptions>)
    const text = 'model=pro seat=auto tools=shared json=true prompt=System: Be brief.\n\nUser: hello\n\nAssistant: hi\n\nUser: bye'
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect(warnings).toHaveLength(1)
  })

  it('surfaces a drained pool as a rate limit with the driver sentence', async () => {
    const adapter = new AntigravityAdapter({ options: () => ({ ...OPTIONS, driver: fixture('driver-quota.mjs') }) })
    await expect(collect(adapter, { messages: [message('user', 'hello')] })).rejects.toMatchObject({
      code: 'RATE_LIMIT',
      message: expect.stringContaining('no pool seat could answer'),
    })
  })

  it('kills a hung driver when the caller aborts', async () => {
    const adapter = new AntigravityAdapter({ options: () => ({ ...OPTIONS, driver: fixture('driver-hang.mjs') }) })
    const controller = new AbortController()
    setTimeout(() => { controller.abort() }, 200)
    await expect(collect(adapter, { messages: [message('user', 'hello')], signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('refuses a model tier the driver cannot resolve before starting it', async () => {
    const adapter = new AntigravityAdapter({ options: () => ({ ...OPTIONS, driver: fixture('missing.mjs') }) })
    await expect(collect(adapter, { model: 'gemini-3', messages: [message('user', 'x')] })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('reports a missing driver as a transport failure', async () => {
    const adapter = new AntigravityAdapter({ options: () => ({ ...OPTIONS, driver: fixture('missing.mjs') }) })
    await expect(collect(adapter, { messages: [message('user', 'x')] })).rejects.toMatchObject({ code: 'TRANSPORT' })
  })
})
