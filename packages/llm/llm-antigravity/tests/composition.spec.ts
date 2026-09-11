/**
 * Proof that the plugin mounts: the route is asked for from the LLM runtime,
 * not from the plugin, so an entry that type-checks but fails to register
 * cannot pass.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmAntigravity from '../src/index.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

async function mount(config: LlmAntigravity.Config = {}): Promise<Context> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmAntigravity, config)
  return ctx
}

describe('composition', () => {
  it('resolves an empty config without materializing defaults that fail boot', () => {
    expect(() => LlmAntigravity.Config({})).not.toThrow()
  })

  it('registers the antigravity route under its picker name', async () => {
    const ctx = await mount()
    const entry = ctx.llm.listProviders().find(provider => provider.id === 'antigravity')
    expect(entry?.name).toBe('Antigravity')
  })

  it('advertises the three Gemini tiers the driver resolves', async () => {
    const ctx = await mount()
    const models = await ctx.llm.listModels('antigravity')
    expect(models.map(model => model.id)).toEqual(['flash_lite', 'flash', 'pro'])
  })

  it('reports the configured context window', async () => {
    const ctx = await mount({ defaultContextWindow: 50_000 })
    const model = await ctx.llm.resolveModelInfo('antigravity', 'flash')
    expect(model.context?.contextWindow).toBe(50_000)
    expect(model.name).toBe('Gemini Flash (Antigravity)')
  })

  it('refuses a config the driver would reject', async () => {
    await expect(mount({ seat: 'Shift A' })).rejects.toThrow('seat')
    await expect(mount({ maxPromptChars: 40_000 })).rejects.toThrow('maxPromptChars')
  })
})
