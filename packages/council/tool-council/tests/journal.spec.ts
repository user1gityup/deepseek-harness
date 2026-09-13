import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Agents, { type Agent } from '@deepseek-ai/dsh-agent'
import Sessions from '@deepseek-ai/dsh-session'
import Tools from '@deepseek-ai/dsh-tools'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Settings from '@deepseek-ai/dsh-settings-file'
import Web from '@deepseek-ai/dsh-web'
import { CallId } from '@deepseek-ai/dsh-llm'
import * as Council from '../src/index.ts'
import { discardJournal, JOURNAL_MAX_AGE_MS, journalKey, openJournal, recallReply, recordReply, withJournal } from '../src/journal.ts'
import { askSeat, DEFAULT_SEATS } from '../src/seats.ts'
import type { SeatConfig } from '../src/seats.ts'

const RUN = '0b1c2d3e-4f50-4617-8899-aabbccddeeff'
const seat: SeatConfig = { id: 'kimi', name: 'Kimi', transport: 'openrouter', model: 'moonshotai/kimi-k2', enabled: true }

interface SettingsFace {
  get: (name: string) => Record<string, unknown> | undefined
  update: (name: string, value: Record<string, unknown>) => Promise<void>
}

let root: string | undefined
let ctx: Context | undefined
afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('journal', () => {
  it('hands a recorded answer back to the same run after a restart', async () => {
    root = await mkdtemp(join(tmpdir(), 'journal-'))
    await withJournal(openJournal(RUN, root), async () => {
      expect(recallReply(seat, 'plan it')).toBeUndefined()
      recordReply(seat, 'plan it', { seat: 'kimi', text: 'the plan', ms: 1200, usage: { costUsd: 0.4 } })
    })
    // A fresh load is what a host restart sees.
    const reopened = openJournal(RUN, root)
    await withJournal(reopened, async () => {
      expect(recallReply(seat, 'plan it')).toEqual({ seat: 'kimi', text: 'the plan', ms: 1200 })
      expect(recallReply(seat, 'a different prompt')).toBeUndefined()
      expect(recallReply({ ...seat, model: 'another/model' }, 'plan it')).toBeUndefined()
    })
    expect(reopened?.hits).toBe(1)
  })

  it('never records a failure or an empty answer, so a resume asks those again', async () => {
    root = await mkdtemp(join(tmpdir(), 'journal-'))
    await withJournal(openJournal(RUN, root), async () => {
      recordReply(seat, 'a', { seat: 'kimi', text: '', ms: 5, error: 'timed out' })
      recordReply(seat, 'b', { seat: 'kimi', text: '   ', ms: 5 })
    })
    expect(openJournal(RUN, root)?.entries.size).toBe(0)
  })

  it('skips a torn last line and keeps the answers before it', async () => {
    root = await mkdtemp(join(tmpdir(), 'journal-'))
    const good = JSON.stringify({ key: journalKey(seat, 'p'), at: Date.now(), reply: { seat: 'kimi', text: 'kept', ms: 1 } })
    await writeFile(join(root, `${RUN}.jsonl`), `${good}\n{"key":"torn`)
    expect(openJournal(RUN, root)?.entries.size).toBe(1)
  })

  it('stops handing back an answer once it is a day old', async () => {
    root = await mkdtemp(join(tmpdir(), 'journal-'))
    await withJournal(openJournal(RUN, root), async () => {
      recordReply(seat, 'p', { seat: 'kimi', text: 'x', ms: 1 })
    })
    expect(openJournal(RUN, root, Date.now() + JOURNAL_MAX_AGE_MS - 60_000)?.entries.size).toBe(1)
    expect(openJournal(RUN, root, Date.now() + JOURNAL_MAX_AGE_MS + 60_000)?.entries.size).toBe(0)
  })

  it('does nothing outside a run, and refuses an id that is not a run id', async () => {
    root = await mkdtemp(join(tmpdir(), 'journal-'))
    recordReply(seat, 'p', { seat: 'kimi', text: 'x', ms: 1 })
    expect(recallReply(seat, 'p')).toBeUndefined()
    expect(openJournal('../../etc/passwd', root)).toBeUndefined()
  })

  it('is deleted when the run is discarded', async () => {
    root = await mkdtemp(join(tmpdir(), 'journal-'))
    await withJournal(openJournal(RUN, root), async () => {
      recordReply(seat, 'p', { seat: 'kimi', text: 'x', ms: 1 })
    })
    expect(existsSync(join(root, `${RUN}.jsonl`))).toBe(true)
    discardJournal(RUN, root)
    expect(existsSync(join(root, `${RUN}.jsonl`))).toBe(false)
  })

  it('stops askSeat from running a real seat process a second time', async () => {
    root = await mkdtemp(join(tmpdir(), 'journal-'))
    const counter = join(root, 'spawns.txt')
    const cli: SeatConfig = {
      id: 'counter',
      name: 'Counter',
      transport: 'cli',
      command: process.execPath,
      args: ['-e', `require('fs').appendFileSync(${JSON.stringify(counter)}, 'x'); process.stdout.write('answer')`],
      enabled: true,
    }
    const spawns = async () => (existsSync(counter) ? (await readFile(counter, 'utf8')).length : 0)
    const first = await withJournal(openJournal(RUN, root), async () => await askSeat(cli, 'q', undefined, undefined, 30_000))
    expect(first.text).toBe('answer')
    expect(await spawns()).toBe(1)
    const again = await withJournal(openJournal(RUN, root), async () => await askSeat(cli, 'q', undefined, undefined, 30_000))
    expect(again.text).toBe('answer')
    expect(await spawns()).toBe(1)
    // Outside a run nothing is recalled.
    await askSeat(cli, 'q', undefined, undefined, 30_000)
    expect(await spawns()).toBe(2)
  }, 30_000)
})

/**
 * Boot the council plugin through the real loader and tool registry, with two
 * hosted seats whose endpoint is answered in-process and counted.
 * @returns a tool caller, the settings face, and the seat call count.
 */
async function bootCouncil() {
  await mkdir('.dsh-build', { recursive: true })
  root = await mkdtemp(join(process.cwd(), '.dsh-build', 'journal-tool-'))
  // The journal lives under the home folder; keep this test's out of the real one.
  vi.stubEnv('USERPROFILE', root)
  vi.stubEnv('HOME', root)
  const seen = { calls: 0, idAtFirstCall: undefined as unknown }
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    if (!String(url).includes('seat.test')) {
      return new Response(JSON.stringify({ data: [] }), { headers: { 'Content-Type': 'application/json' } })
    }
    seen.calls += 1
    if (seen.calls === 1) seen.idAtFirstCall = (ctx?.get('settings') as unknown as SettingsFace | undefined)?.get('council')?.['pipelineId']
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { model: string }
    const content = `VOTE: seat-a\nCONFIDENCE: 0.9\nCRITIQUE: sound.\n\nPlan from ${body.model}: build it in two steps.`
    return new Response(JSON.stringify({ choices: [{ message: { content } }], model: body.model }), { headers: { 'Content-Type': 'application/json' } })
  })
  const config = join(root, 'cordis.yml')
  await writeFile(config, JSON.stringify([
    { name: 'sessions' }, { name: 'agents' }, { name: 'prompt' }, { name: 'tools' }, { name: 'web' },
    { name: 'settings', config: { path: join(root, 'settings.json'), watch: false } },
    { name: 'council', config: { apiKeyEnv: 'JOURNAL_TEST_KEY',
      seats: Object.fromEntries(DEFAULT_SEATS.map(entry => [entry.id, { enabled: false }])),
      extraSeats: {
        'seat-a': { model: 'test-a', baseUrl: 'http://seat.test/v1/chat/completions' },
        'seat-b': { model: 'test-b', baseUrl: 'http://seat.test/v1/chat/completions' },
      },
    } },
  ]))
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['sessions', Sessions], ['agents', Agents], ['prompt', Prompt], ['tools', Tools], ['settings', Settings], ['web', Web], ['council', Council]])
  ctx.loader.internal = { version: 'v2', async import(name: string) { if (!modules.has(name)) throw new Error(name); return modules.get(name) } } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  const app = ctx
  const session = app.sessions.create(undefined, { meta: { cwd: root } })
  const agent = { id: session.id, session, options: {} } as Agent
  const call = async (tool: string, id: string, args: Record<string, unknown>) => await app.agents.withInitiator(agent, () =>
    app.tools.execute({ agent, signal: new AbortController().signal, callId: CallId(id), name: tool, arguments: args }))
  const settings = app.get('settings') as unknown as SettingsFace
  return { call, settings, seen }
}

it('records a pipeline run before its stage spends, and a re-entered stage asks no seat twice', async () => {
  const { call, settings, seen } = await bootCouncil()
  const first = await call('pipeline', 'first', { query: 'Plan a small tool.', stages: 'council' })
  const afterFirst = seen.calls
  expect(afterFirst).toBeGreaterThan(0)
  // Written before the first seat was asked: an abort at that moment still leaves a run to continue.
  expect(typeof seen.idAtFirstCall).toBe('string')
  expect(seen.idAtFirstCall).not.toBe('')
  expect(settings.get('council')?.['pipelineId']).toBe(seen.idAtFirstCall)
  expect(JSON.stringify(first)).not.toContain('Resumed:')

  // Continue: the same stage again, under the same run id.
  const second = await call('pipeline', 'second', {})
  expect(seen.calls).toBe(afterFirst)
  expect(JSON.stringify(second)).toContain('Resumed:')
}, 60_000)

it('gives a council re-called after an abort the answers it had already collected', async () => {
  const { call, settings, seen } = await bootCouncil()
  await call('council', 'first', { query: 'Plan a small tool.' })
  const afterFirst = seen.calls
  expect(afterFirst).toBeGreaterThan(0)
  // An abort means the plan was never issued to the gate: clear what a finished call left.
  await settings.update('council', { pendingPlanId: '', pendingPlanQuery: '', pendingPlanText: '', pendingPlanIssuedAt: 0 })
  const again = await call('council', 'again', { query: 'Plan a small tool.' })
  expect(seen.calls).toBe(afterFirst)
  expect(JSON.stringify(again)).toContain('Resumed:')
  // A different question is not a resume.
  await settings.update('council', { pendingPlanId: '', pendingPlanQuery: '', pendingPlanText: '', pendingPlanIssuedAt: 0 })
  await call('council', 'other', { query: 'Plan a different tool.' })
  expect(seen.calls).toBeGreaterThan(afterFirst)
}, 60_000)
