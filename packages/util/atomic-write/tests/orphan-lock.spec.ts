/**
 * Orphan recovery for the cross-process writer lock.
 *
 * The failure these cover happened for real on 2026-09-06: a host process was
 * killed while holding the lock on `settings.yaml`, and because the protocol
 * refused to break any lock, every later writer timed out against a dead
 * owner until the file was deleted by hand.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { hostname, tmpdir, uptime } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withFileLock } from '../src/index.ts'

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-orphan-lock-'))
}

/** This boot as an epoch instant, the same reading the lock records. */
function bootInstant(): number {
  return Date.now() - Math.round(uptime() * 1000)
}

/** Start a child, wait for it to exit, and hand back its now-dead pid. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const pid = child.pid
  if (pid === undefined) throw new Error('the probe child reported no pid')
  await new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve()
    })
  })
  return pid
}

/** Write a lock file naming `owner` as its holder. */
async function plantLock(lockPath: string, owner: Record<string, unknown> | string): Promise<void> {
  await writeFile(lockPath, `${typeof owner === 'string' ? owner : JSON.stringify(owner)}\n`, { mode: 0o600 })
}

describe('orphaned writer locks', () => {
  it('takes over a lock whose owner has exited', async () => {
    const dir = await scratch()
    const target = join(dir, 'settings.yaml')
    await plantLock(`${target}.lock`, {
      pid: await deadPid(),
      host: hostname(),
      boot: bootInstant(),
      token: 'deadbeefdeadbeef',
    })

    // The default wait is 2s; acquiring inside a 200ms limit proves the lock
    // was broken on proof rather than waited out.
    expect(await withFileLock(target, async () => 'wrote', { waitMs: 200 })).toBe('wrote')
  })

  it('takes over a lock left by a previous boot', async () => {
    const dir = await scratch()
    const target = join(dir, 'settings.yaml')
    // A pid that is alive right now — this process — but recorded against a
    // boot that is not this one. Nothing from that boot can still hold it.
    await plantLock(`${target}.lock`, {
      pid: process.pid,
      host: hostname(),
      boot: bootInstant() - 7 * 24 * 60 * 60 * 1000,
      token: 'oldbootoldboot00',
    })

    expect(await withFileLock(target, async () => 'wrote', { waitMs: 200 })).toBe('wrote')
  })

  it('takes over a bare-pid lock written before locks recorded an identity', async () => {
    const dir = await scratch()
    const target = join(dir, 'settings.yaml')
    await plantLock(`${target}.lock`, String(await deadPid()))

    expect(await withFileLock(target, async () => 'wrote', { waitMs: 200 })).toBe('wrote')
  })

  it('takes over a lock that records no owner at all', async () => {
    const dir = await scratch()
    const target = join(dir, 'settings.yaml')
    const lockPath = `${target}.lock`
    await writeFile(lockPath, '', { mode: 0o600 })
    // Past the grace period that protects a lock still being written.
    await new Promise(resolve => setTimeout(resolve, 1_100))

    expect(await withFileLock(target, async () => 'wrote', { waitMs: 300 })).toBe('wrote')
  })

  // Content this package did not write claims an owner that cannot be
  // checked, and an unreadable claim is still a claim.
  it('never breaks a lock whose content it cannot read', async () => {
    const dir = await scratch()
    const target = join(dir, 'settings.yaml')
    await plantLock(`${target}.lock`, 'slow-holder')

    await expect(withFileLock(target, async () => 'wrote', { waitMs: 100 }))
      .rejects.toThrow(/timed out waiting for the writer lock/)
  })

  it('leaves a live owner alone', async () => {
    const dir = await scratch()
    const target = join(dir, 'settings.yaml')
    await plantLock(`${target}.lock`, {
      pid: process.pid,
      host: hostname(),
      boot: bootInstant(),
      token: 'liveliveliveliv0',
    })

    await expect(withFileLock(target, async () => 'wrote', { waitMs: 100 }))
      .rejects.toThrow(/timed out waiting for the writer lock/)
  })

  // Shared storage: this host cannot check another machine's pid, and a guess
  // would strip a live writer's protection.
  it('never breaks a lock held on another machine', async () => {
    const dir = await scratch()
    const target = join(dir, 'settings.yaml')
    await plantLock(`${target}.lock`, {
      pid: await deadPid(),
      host: `${hostname()}-elsewhere`,
      boot: bootInstant(),
      token: 'remoteremote0000',
    })

    await expect(withFileLock(target, async () => 'wrote', { waitMs: 100 }))
      .rejects.toThrow(/timed out waiting for the writer lock/)
  })

  it('releases only the lock it took', async () => {
    const dir = await scratch()
    const target = join(dir, 'settings.yaml')
    const lockPath = `${target}.lock`
    const successor = { pid: process.pid, host: hostname(), boot: bootInstant(), token: 'successor0000000' }

    await withFileLock(target, async () => {
      // Stand in for a contender that judged this holder dead and took over.
      await writeFile(lockPath, `${JSON.stringify(successor)}\n`, { flag: 'w' })
    })

    // The successor's lock must survive this holder's release.
    expect(JSON.parse((await readFile(lockPath, 'utf8')).trim())).toMatchObject({ token: 'successor0000000' })
  })

  it('removes its own lock on the way out', async () => {
    const dir = await scratch()
    const target = join(dir, 'settings.yaml')

    await withFileLock(target, async () => 'wrote')

    await expect(stat(`${target}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
