/**
 * Proof that the plugin actually mounts.
 *
 * A green build says nothing about whether cordis will accept the plugin: an
 * entry that type-checks can still fail to register at runtime. This test
 * mounts it on a real Context beside the LLM runtime and asks the runtime —
 * not the plugin — whether the route arrived.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmClaudeCli from '../src/index.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

/** Mount the runtime and this plugin, with no settings provider present. */
async function mount(config: LlmClaudeCli.Config = {}): Promise<Context> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmClaudeCli, config)
  return ctx
}

describe('composition', () => {
  it('registers the claude-cli route on the runtime', async () => {
    const ctx = await mount()
    expect(ctx.llm.listProviders().map(entry => entry.id)).toContain('claude-cli')
  })

  it('names the provider for the model picker', async () => {
    const ctx = await mount()
    const entry = ctx.llm.listProviders().find(provider => provider.id === 'claude-cli')
    expect(entry?.name).toBe('Claude Code CLI')
  })

  it('advertises the CLI model aliases', async () => {
    const ctx = await mount()
    const models = await ctx.llm.listModels('claude-cli')
    expect(models.map(model => model.id)).toEqual(['opus', 'sonnet', 'haiku'])
  })

  it('reports the configured context window for an unlisted model', async () => {
    const ctx = await mount({ defaultContextWindow: 123_000 })
    const model = await ctx.llm.resolveModelInfo('claude-cli', 'claude-opus-5')
    expect(model.context?.contextWindow).toBe(123_000)
    expect(model.id).toBe('claude-opus-5')
  })
})
