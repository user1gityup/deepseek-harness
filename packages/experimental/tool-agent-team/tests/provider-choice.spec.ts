import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import TeamService from '../../agent-team/src/index.ts'
import * as toolTeam from '../src/index.ts'

/**
 * Per-teammate provider selection.
 *
 * A swarm is only worth more than one agent if its workers can differ — the
 * seat that reads the filesystem is not the seat that should be doing bulk
 * prose. The roster already stored a provider per member and descriptor
 * matching already keyed off it; only the Lead's ability to choose was
 * missing. These tests hold that choice open, and hold the refusal closed.
 */

const SIGNAL = new AbortController().signal
const roots: string[] = []
let callNumber = 0

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Compose a host with two subagent providers registered. */
async function setup() {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-provider-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  await ctx.plugin(TeamService)
  await ctx.plugin(toolTeam)
  const adapter = new MockAdapter([])
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = ctx.agentLoop.create(SessionId('provider-lead'), { provider: 'mock', model: 'mock' })
  return { ctx, lead }
}

/** Run one tool call. */
function execute(ctx: Context, agent: Agent | undefined, name: string, args: unknown) {
  return ctx.tools.execute({
    callId: CallId(`provider-call-${++callNumber}`),
    name,
    arguments: args,
    signal: SIGNAL,
    ...agent === undefined ? {} : { agent },
  })
}

/** Flatten a tool result to text. */
function text(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/** Read the spawned member's provider out of a spawn result. */
function memberProvider(result: Awaited<ReturnType<typeof execute>>): string | undefined {
  const parsed: unknown = JSON.parse(text(result))
  if (typeof parsed !== 'object' || parsed === null || !('member' in parsed)) return undefined
  const member = (parsed as { member: unknown }).member
  if (typeof member !== 'object' || member === null || !('provider' in member)) return undefined
  const provider = (member as { provider: unknown }).provider
  return typeof provider === 'string' ? provider : undefined
}

describe('per-teammate provider selection', () => {
  it('lists the providers registered on this host', async () => {
    const { ctx, lead } = await setup()
    const result = await execute(ctx, lead, 'list_providers', {})
    expect(result.isError).toBe(false)
    const body = text(result)
    expect(body).toContain('spawn')
    expect(body).toContain('fork')
  })

  it('spawns a teammate on the provider the Lead names', async () => {
    const { ctx, lead } = await setup()
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'fork-worker',
      description: 'runs on the fork provider',
      prompt: 'stay available',
      provider: 'fork',
    })
    expect(spawned.isError).toBe(false)
    expect(memberProvider(spawned)).toBe('fork')
    await execute(ctx, lead, 'interrupt_agent', { target: 'fork-worker' })
  })

  it('falls back to the configured default when no provider is named', async () => {
    const { ctx, lead } = await setup()
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'default-worker',
      description: 'takes the default',
      prompt: 'stay available',
    })
    expect(spawned.isError).toBe(false)
    // freshProvider defaults to 'spawn'.
    expect(memberProvider(spawned)).toBe('spawn')
    await execute(ctx, lead, 'interrupt_agent', { target: 'default-worker' })
  })

  it('refuses an unknown provider and names the ones that exist', async () => {
    // Failing here rather than deep inside dispatch is the difference between
    // a recoverable authoring mistake and a teammate that never starts.
    const { ctx, lead } = await setup()
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'ghost-worker',
      description: 'names a provider that is not registered',
      prompt: 'stay available',
      provider: 'no-such-provider',
    })
    expect(spawned.isError).toBe(true)
    const body = text(spawned)
    expect(body).toContain('no-such-provider')
    expect(body).toContain('spawn')
    expect(body).toContain('fork')
  })

  it('spawns two teammates on different providers at once', async () => {
    // The point of the whole change: a heterogeneous team, not N clones.
    const { ctx, lead } = await setup()
    const [a, b] = await Promise.all([
      execute(ctx, lead, 'spawn_teammate', {
        name: 'worker-a', description: 'first', prompt: 'stay available', provider: 'spawn',
      }),
      execute(ctx, lead, 'spawn_teammate', {
        name: 'worker-b', description: 'second', prompt: 'stay available', provider: 'fork',
      }),
    ])
    expect(a?.isError).toBe(false)
    expect(b?.isError).toBe(false)
    expect(memberProvider(a!)).toBe('spawn')
    expect(memberProvider(b!)).toBe('fork')

    const listed = await execute(ctx, lead, 'list_agents', {})
    expect(text(listed)).toContain('worker-a')
    expect(text(listed)).toContain('worker-b')

    await execute(ctx, lead, 'interrupt_agent', { target: 'worker-a' })
    await execute(ctx, lead, 'interrupt_agent', { target: 'worker-b' })
    await vi.waitFor(() => { expect(true).toBe(true) }, { timeout: 1_000 })
  })
})
