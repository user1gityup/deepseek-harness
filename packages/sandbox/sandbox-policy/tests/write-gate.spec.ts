import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { type Session } from '@deepseek-ai/dsh-session'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import Policy, { setSandboxMode } from '../src/index.ts'

afterEach(() => vi.useRealTimers())

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(Policy, { requireWriteConfirmation: true, confinedOnly: true, writeApprovalTtlMs: 1000 })
  const session = ctx.sessions.create()
  return { ctx, session, fiber }
}
function message(text: string, human = true) {
  return createUserMessage({ content: [{ type: 'text', text }], source: human ? { kind: 'user' } : { kind: 'plugin', plugin: 'test' } })
}
async function enter(ctx: Context, session: Session, input: UserMessage) {
  const agent = { id: session.id, session } as Agent
  const messages = [input]
  return agentEvents(ctx, agent).waterfall('agent/pre-step', { messages, turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages }))
}

describe('workspace write approval and go', () => {
  it('requires both factors in order, then permits repeated workspace operations', async () => {
    const { ctx, session } = await setup()
    await enter(ctx, session, message('go'))
    expect(ctx.sandboxPolicy.resolve({ session, mode: 'workspace-write' }).mode).toBe('read-only')
    ctx.sandboxPolicy.approveWorkspaceWrites(session)
    expect(ctx.sandboxPolicy.resolve({ session, mode: 'workspace-write' }).mode).toBe('read-only')
    await enter(ctx, session, message('what will change?'))
    await enter(ctx, session, message('go', false))
    expect(ctx.sandboxPolicy.resolve({ session }).mode).toBe('read-only')
    await enter(ctx, session, message('GO'))
    expect(ctx.sandboxPolicy.resolve({ session }).mode).toBe('workspace-write')
    expect(ctx.sandboxPolicy.resolve({ session }).mode).toBe('workspace-write')
    expect(() => ctx.sandboxPolicy.resolve({ session, mode: 'danger-full-access' })).toThrow('Unconfined')
  })
  it('does not accept a queued go that predates approval or another session\'s go', async () => {
    const { ctx, session } = await setup()
    const queued = message('go')
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [queued] })
    ctx.sandboxPolicy.approveWorkspaceWrites(session)
    await enter(ctx, session, queued)
    await enter(ctx, ctx.sessions.create(), message('go'))
    expect(ctx.sandboxPolicy.resolve({ session }).mode).toBe('read-only')
  })
  it('expires pending approvals and revokes on read-only, reload and replay', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { ctx, session, fiber } = await setup()
    ctx.sandboxPolicy.approveWorkspaceWrites(session)
    vi.setSystemTime(Date.now() + 1001)
    await enter(ctx, session, message('go'))
    expect(ctx.sandboxPolicy.resolve({ session }).mode).toBe('read-only')
    ctx.sandboxPolicy.approveWorkspaceWrites(session)
    await enter(ctx, session, message('go'))
    setSandboxMode(session, 'read-only')
    expect(ctx.sandboxPolicy.resolve({ session, mode: 'workspace-write' }).mode).toBe('read-only')
    ctx.sandboxPolicy.approveWorkspaceWrites(session)
    await enter(ctx, session, message('go'))
    await fiber.dispose()
    await ctx.plugin(Policy, { requireWriteConfirmation: true, confinedOnly: true })
    expect(ctx.sandboxPolicy.resolve({ session }).mode).toBe('read-only')
    expect(ctx.sandboxPolicy.resolve({ mode: 'workspace-write' }).mode).toBe('read-only')
  })
  it('refuses delegated approval and does not honour a persisted full-access mode', async () => {
    const { ctx, session } = await setup()
    const child = ctx.sessions.create(undefined, { meta: { delegationDepth: 1 } })
    expect(() => ctx.sandboxPolicy.approveWorkspaceWrites(child)).toThrow('Delegated')
    setSandboxMode(session, 'danger-full-access')
    expect(ctx.sandboxPolicy.resolve({ session }).mode).toBe('read-only')
  })
})
