/**
 * The seat pool reader, against real loopback servers and a real pool root on
 * disk: a signed-in seat, a signed-out seat, a seat whose process is gone, and
 * a second seat signed in to the first seat's Google account.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { combine, inflightBySeat, readDiscovery, readParked, readPool, readRegistry } from '../src/pool.ts'
import { QUOTA_PATH, STATUS_PATH, tokenOf } from '../src/reading.ts'
import type { QuotaBucket } from '../src/reading.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

function bucket(id: string, remaining: number, resetsAt: number | null = null): QuotaBucket {
  return { id, group: 'Gemini Models', label: 'Weekly', remaining, window: 'weekly', resetsAt, note: null }
}

/** A loopback server answering the two Connect methods the pool reads. */
async function seatServer(answer: { fraction?: number; email?: string; tier?: string; signedOut?: boolean }): Promise<number> {
  const server: Server = createServer((req, res) => {
    if (req.headers['x-codeium-csrf-token'] !== 'seat-token') { res.writeHead(403); res.end(); return }
    if (answer.signedOut) { res.writeHead(500); res.end('You are not logged into Antigravity.'); return }
    res.writeHead(200)
    if (req.url === QUOTA_PATH) {
      res.end(JSON.stringify({ response: { groups: [{ displayName: 'Gemini Models', buckets: [
        { bucketId: 'gemini-weekly', remainingFraction: answer.fraction ?? 1, resetTime: '2026-09-15T23:23:14Z' },
      ] }] } }))
    } else if (req.url === STATUS_PATH) {
      res.end(JSON.stringify({ userStatus: { email: answer.email, userTier: { id: answer.tier, name: 'Tier' }, planStatus: { planInfo: { planName: 'Pro' } } } }))
    } else res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => { server.closeAllConnections(); return new Promise(resolve => server.close(() => resolve())) })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('missing address')
  return address.port
}

async function seatDir(root: string, id: string, discovery?: Record<string, unknown>): Promise<string> {
  const dir = join(root, 'profiles', id)
  await mkdir(join(dir, 'antigravity', 'daemon'), { recursive: true })
  if (discovery) await writeFile(join(dir, 'antigravity', 'daemon', 'ls_abc.json'), JSON.stringify(discovery))
  return dir
}

async function poolRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'antigravity-pool-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

describe('Antigravity seat pool', () => {
  it('weights buckets by tier, keeps the soonest reset and counts accounts', () => {
    const combined = combine([
      { weight: 1, buckets: [bucket('gemini-weekly', 97.6, 300), bucket('3p-weekly', 100, 500)] },
      { weight: 1, buckets: [bucket('gemini-weekly', 0.3, 100)] },
      { weight: 4, buckets: [bucket('gemini-weekly', 50, null)] },
      { weight: 0, buckets: [bucket('gemini-weekly', 100, 1)] },
    ])
    expect(combined).toEqual([
      // (97.6 + 0.3 + 4 × 50) / 6 — the Pro-weighted account dominates.
      expect.objectContaining({ id: 'gemini-weekly', remaining: 49.7, resetsAt: 100, accounts: 3 }),
      expect.objectContaining({ id: '3p-weekly', remaining: 100, resetsAt: 500, accounts: 1 }),
    ])
    expect(combine([])).toEqual([])
  })

  it('reads a BOM-prefixed registry and ignores invalid or duplicate seats', async () => {
    const root = await poolRoot()
    await writeFile(join(root, 'accounts.json'), `\uFEFF${JSON.stringify({ seats: [
      { id: 'seat1', label: 'Shift A' }, { id: 'seat1' }, { id: 'Bad Id' }, { id: 'ide' }, { id: 'fam1', weight: 4, geminiDir: 'D:\\seats\\fam1' },
    ] })}`)
    expect(readRegistry(root)).toEqual([
      { id: 'seat1', label: 'Shift A', geminiDir: join(root, 'profiles', 'seat1'), weight: undefined },
      { id: 'fam1', label: 'fam1', geminiDir: 'D:\\seats\\fam1', weight: 4 },
    ])
    expect(readRegistry(join(root, 'missing'))).toEqual([])
  })

  it('reads discovery ports, live leases and unexpired parking without removing anything', async () => {
    const root = await poolRoot()
    const dir = await seatDir(root, 'seat1', { pid: 42, csrfToken: 'seat-token', httpPort: '5001', httpsPort: 5002, lspPort: 5003 })
    expect(readDiscovery(dir)).toEqual({ pid: 42, csrfToken: 'seat-token', ports: [5001, 5002] })
    expect(readDiscovery(join(root, 'profiles', 'none'))).toBeUndefined()
    await mkdir(join(root, 'leases'))
    await writeFile(join(root, 'leases', `seat1.${String(process.pid)}.lease`), '{}')
    await writeFile(join(root, 'leases', 'seat1.2147483646.lease'), '{}')
    expect(inflightBySeat(root).get('seat1')).toBe(1)
    await writeFile(join(root, 'parked.json'), JSON.stringify({ seat1: { until: '2026-09-15T00:00:00Z' }, fam1: { until: '2020-01-01T00:00:00Z' } }))
    expect([...readParked(root, Date.parse('2026-09-11T00:00:00Z')).keys()]).toEqual(['seat1'])
  })

  it('combines distinct signed-in accounts and reports every seat state', async () => {
    const root = await poolRoot()
    const plus = await seatServer({ fraction: 0.9755536, email: 'Sales@Example.com', tier: 'g1-plus-tier' })
    const drained = await seatServer({ fraction: 0.0028208, email: 'two@example.com', tier: 'g1-plus-tier' })
    const same = await seatServer({ fraction: 0.5, email: 'sales@example.com', tier: 'free-tier' })
    const signedOut = await seatServer({ signedOut: true })
    const ids = ['seat1', 'gone1', 'dup1', 'out1', 'down1']
    await writeFile(join(root, 'accounts.json'), JSON.stringify({ seats: ids.map(id => ({ id, label: id })) }))
    // The first port of each seat answers 400, the way a seat's second port does.
    const refuser = createServer((_req, res) => { res.writeHead(400); res.end() })
    await new Promise<void>(resolve => refuser.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise(resolve => refuser.close(() => resolve())))
    const refused = (refuser.address() as { port: number }).port
    await seatDir(root, 'seat1', { pid: process.pid, csrfToken: 'seat-token', httpPort: refused, httpsPort: plus })
    await seatDir(root, 'gone1', { pid: process.pid, csrfToken: 'seat-token', httpPort: drained })
    await seatDir(root, 'dup1', { pid: process.pid, csrfToken: 'seat-token', httpPort: same })
    await seatDir(root, 'out1', { pid: process.pid, csrfToken: 'seat-token', httpPort: signedOut })
    await seatDir(root, 'down1', { pid: 2147483646, csrfToken: 'seat-token', httpPort: plus })

    const reading = await readPool({ root, endpoint: '', includeIde: false, timeoutMs: 5000, signal: new AbortController().signal })
    expect(reading.seats.map(seat => [seat.id, seat.state, seat.counted])).toEqual([
      ['seat1', 'ok', true], ['gone1', 'ok', true], ['dup1', 'ok', false], ['out1', 'signed-out', false], ['down1', 'down', false],
    ])
    expect(reading.buckets).toEqual([expect.objectContaining({ id: 'gemini-weekly', remaining: 48.9, accounts: 2 })])
    expect(reading.seats[0]).toMatchObject({ tierId: 'g1-plus-tier', weight: 1, source: 'seat' })
    // Account emails de-duplicate in memory and never reach the published rows.
    expect(JSON.stringify(reading)).not.toMatch(/example\.com/i)
  })

  it('refuses an empty pool with no IDE instead of publishing nothing', async () => {
    const root = await poolRoot()
    await expect(readPool({ root, endpoint: '', includeIde: false, timeoutMs: 1000, signal: new AbortController().signal }))
      .rejects.toThrow('No Antigravity seat')
  })

  it('never mistakes a pool seat server for the IDE', () => {
    const ide = 'C:\\antigravity\\resources\\bin\\language_server.exe --csrf_token abcdefgh-123 --app_data_dir antigravity'
    expect(tokenOf(ide)).toBe('abcdefgh-123')
    expect(tokenOf(`${ide} --gemini_dir C:\\Users\\me\\.dsh\\antigravity\\profiles\\seat1`)).toBeUndefined()
    expect(tokenOf(`${ide} -gemini_dir=C:\\seat`)).toBeUndefined()
  })
})
