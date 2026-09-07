/**
 * Zero-dependency atomic file replacement and writer coordination.
 * `writeFileAtomic` writes a random-suffix sibling with exclusive create and
 * the caller's permission bits, then renames it over the target, so readers
 * observe either the old or the new complete content and a replaced file ends
 * up with exactly the stated mode. `withFileLock` serializes cross-process
 * writers of one file through a `wx`-created `<file>.lock` sibling, so a
 * read-modify-write cycle can never resurrect a state another writer just
 * replaced; readers stay lock-free because the rename commit is atomic.
 * @module @deepseek-ai/dsh-atomic-write
 */

import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { hostname, uptime } from 'node:os'
import { dirname } from 'node:path'

/**
 * Filesystem options for {@link writeFileAtomic}; `mode` is required so the
 * permission decision stays visible at every call site.
 */
export interface WriteFileAtomicOptions {
  /**
   * Permission bits stamped on the fresh temp inode and carried through the
   * rename (subject to the process umask, like every fresh inode).
   */
  mode: number
  /**
   * Permission bits for parent directories this call creates (subject to the
   * umask; existing directories keep their mode). Omission uses the mkdir
   * default — pass `0o700` when the tree holds user-private data.
   */
  dirMode?: number
}

/**
 * Replace `filename` with `content` in one atomic step, creating parent
 * directories. The content is first written to a random-suffix sibling opened
 * with exclusive create (`wx`): the open refuses to follow a symlink planted
 * at the temp path, and the fresh inode carries `options.mode` through the
 * rename, so replacing a wider-permission file narrows it without a chmod
 * race. The rename also replaces a symlinked target itself instead of writing
 * through to its referent, and the same-directory sibling keeps the rename on
 * one filesystem. On any failure the temp file is removed and the failure
 * rethrown. Crash durability (fsync) is out of scope.
 * @param filename - final path receiving the content.
 * @param content - complete next file content.
 * @param options - permission bits for the replacement inode.
 */
export async function writeFileAtomic(filename: string, content: string, options: WriteFileAtomicOptions): Promise<void> {
  await mkdir(dirname(filename), {
    recursive: true,
    ...options.dirMode === undefined ? {} : { mode: options.dirMode },
  })
  // TODO(settings-atomic-durability): Use a replacement that fsyncs the file
  // and parent directory and preserves owner-only permissions on Windows.
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, content, { mode: options.mode, flag: 'wx' })
    await rename(temp, filename)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** Whether an exclusive create found an existing lock. */
async function isLockContention(error: unknown, lockPath: string): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'EEXIST') return true
  if (code !== 'EPERM') return false
  try {
    await lstat(lockPath)
    return true
  } catch {
    // Keep the original EPERM authoritative when lock existence is unproven.
    return false
  }
}

/**
 * Retry cadence for a contended lock. These stay robustness invariants of the
 * cross-process write protocol rather than deployment tunables: they govern how
 * often a contender asks, which no caller has a reason to vary.
 */
const LOCK_RETRY_INITIAL_MS = 20
const LOCK_RETRY_MAX_MS = 200

/**
 * Identity a holder records so a contender can tell whether it still exists.
 *
 * Age was the only signal this lock had at first, and age cannot separate a
 * slow holder from a dead one, so the protocol refused to break any lock —
 * which left a real orphan blocking every writer of the file until someone
 * deleted it by hand. Measured 2026-09-06: a killed host process left its lock
 * on `settings.yaml`, and every council run afterwards failed to record its
 * plan, with no way forward from inside the app. A pid, a hostname and a boot
 * instant answer the question age could not.
 */
interface LockOwner {
  readonly pid: number
  readonly host: string
  /** Approximate boot instant, epoch ms: a lock from before it has no owner. */
  readonly boot: number
  /** Per-acquisition id, so a holder only ever releases the lock it took. */
  readonly token: string
}

/**
 * Slack allowed when comparing two boot instants.
 *
 * The instant is derived from `uptime()`, which drifts against the wall clock,
 * so two readings taken on one boot differ by seconds. Only a reboot moves it
 * further than this.
 */
const BOOT_TOLERANCE_MS = 120_000

/**
 * How long a lock carrying no identity is left alone.
 *
 * A holder writes its identity in the same call that creates the file, so an
 * empty lock is a writer that died mid-create — but a contender that saw one a
 * millisecond old could be looking at a lock still being written.
 */
const EMPTY_LOCK_GRACE_MS = 1_000

/** Take-overs allowed in one acquisition, so a pathological loop still ends. */
const MAX_LOCK_BREAKS = 3

/** This boot, as an epoch instant. */
function bootInstant(): number {
  return Date.now() - Math.round(uptime() * 1000)
}

/**
 * Serialise the holder's identity into the lock file.
 * @param owner - the holder taking the lock.
 * @returns the lock file's content.
 */
function encodeOwner(owner: LockOwner): string {
  return `${JSON.stringify(owner)}\n`
}

/**
 * Read a lock file's owner.
 * @param text - the lock file's content.
 * @returns the owner, or undefined when the lock names none.
 */
function parseOwner(text: string): LockOwner | undefined {
  const line = text.trim()
  if (line === '') return undefined
  // Locks written before this package recorded an identity carry the bare pid.
  // Same host, this boot is what those writers meant by it, and it is the only
  // reading available; the pid check still has to agree before anything breaks.
  if (/^\d+$/.test(line)) return { pid: Number(line), host: hostname(), boot: bootInstant(), token: '' }
  let raw: Partial<LockOwner>
  try {
    raw = JSON.parse(line) as Partial<LockOwner>
  } catch {
    return undefined
  }
  if (typeof raw.pid !== 'number' || typeof raw.host !== 'string' || typeof raw.boot !== 'number') return undefined
  return { pid: raw.pid, host: raw.host, boot: raw.boot, token: typeof raw.token === 'string' ? raw.token : '' }
}

/**
 * Whether a pid names a live process on this host.
 * @param pid - the pid recorded in a lock.
 * @returns true when the process exists, including when it cannot be signalled.
 */
function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    // Signal 0 runs the existence and permission checks without delivering
    // anything, on Windows as well, through libuv.
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the pid exists and belongs to someone else: alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Decide whether an existing lock may be taken over.
 * @param lockPath - the contended lock file.
 * @returns why the lock is an orphan, or undefined when it must be waited on.
 */
async function orphanReason(lockPath: string): Promise<string | undefined> {
  let text: string
  try {
    text = await readFile(lockPath, 'utf8')
  } catch {
    // Vanished or unreadable: the retry decides, not a guess made here.
    return undefined
  }
  const owner = parseOwner(text)
  if (owner === undefined) {
    // Content this package did not write claims an owner it cannot check, and
    // an unreadable claim is still a claim: only a file with nothing in it is
    // treated as ownerless.
    if (text.trim() !== '') return undefined
    let ageMs: number
    try {
      ageMs = Date.now() - (await lstat(lockPath)).mtimeMs
    } catch {
      return undefined
    }
    return ageMs > EMPTY_LOCK_GRACE_MS ? 'it records no owner' : undefined
  }
  // Another machine's lock on shared storage: this host cannot check that pid,
  // and guessing would break a live holder.
  if (owner.host !== hostname()) return undefined
  if (Math.abs(owner.boot - bootInstant()) > BOOT_TOLERANCE_MS) {
    return `its owner (pid ${String(owner.pid)}) predates this boot`
  }
  if (processExists(owner.pid)) return undefined
  return `its owner (pid ${String(owner.pid)}) no longer exists`
}

/**
 * Remove an orphaned lock without racing another contender that judged it the
 * same way. The rename is the claim: whoever loses it finds the lock already
 * gone and simply retries.
 * @param lockPath - the orphaned lock file.
 */
async function breakLock(lockPath: string): Promise<void> {
  const aside = `${lockPath}.orphan-${randomBytes(6).toString('hex')}`
  try {
    await rename(lockPath, aside)
  } catch {
    return
  }
  await rm(aside, { force: true })
}

/**
 * Release a lock, but only while this holder's token is still in it.
 * @param lockPath - the lock file to release.
 * @param owner - the identity written when it was taken.
 */
async function releaseLock(lockPath: string, owner: LockOwner): Promise<void> {
  try {
    const held = parseOwner(await readFile(lockPath, 'utf8'))
    // A lock taken over from a process wrongly judged dead belongs to its new
    // owner; removing it here would strip a live writer's protection.
    if (held !== undefined && held.token !== '' && held.token !== owner.token) return
  } catch {
    return
  }
  await rm(lockPath, { force: true })
}

/**
 * How long a contender waits when the caller states no limit — sized for the
 * render-and-rename cycle every call site had when this package was written.
 * Expiry fails the contender rather than guessing whether the existing lock
 * still has an owner. How long is *worth* waiting is a property of the
 * operation the lock holder runs, which is why {@link FileLockOptions.waitMs}
 * exists; the value here is the floor for an operation that does file work
 * alone.
 */
const DEFAULT_LOCK_WAIT_MS = 2_000

/** Options for one {@link withFileLock} acquisition. */
export interface FileLockOptions {
  /**
   * Maximum time to wait for the lock, in milliseconds. State one when the
   * holder's operation legitimately runs longer than file work — a credential
   * mutation that refreshes a token performs a network round trip while
   * holding the lock, and leaving the default in place would fail every other
   * writer of the same file for the duration. Waiting is productive: a
   * contender that acquires the lock afterwards re-reads the committed state.
   */
  waitMs?: number
}

/**
 * Hold the cross-process writer lock for `filename` around one operation. The
 * lock is a `wx`-created sibling (`<filename>.lock`); paired with the
 * rename-based commit of {@link writeFileAtomic}, readers stay lock-free and
 * only writers contend. `EEXIST` is contention directly; an `EPERM` is
 * contention only when a fresh `lstat` confirms the lock path exists, covering
 * Windows exclusive-create behavior without hiding an unrelated permission
 * failure. Contention backs off exponentially and fails with a timed-out error
 * after the deadline.
 *
 * A contender takes an existing lock over only on proof that its owner is
 * gone — never on age, which says nothing about a slow holder. The lock
 * records the holder's pid, hostname and boot instant, so proof means: the
 * lock was taken on this host, and either predates this boot or names a pid
 * that no longer exists. A lock from another machine is never broken, and a
 * pid that exists but cannot be signalled counts as alive. Release is equally
 * narrow: a holder removes the lock only while its own token is still in it,
 * so a lock taken over from a process wrongly judged dead is not stripped
 * from its new owner. The parent directory must exist.
 * @param filename - the file whose writers this lock serializes.
 * @param operation - the read-render-commit cycle to run while holding the lock.
 * @param options - acquisition options; omitted waits {@link DEFAULT_LOCK_WAIT_MS}.
 * @returns the operation's result; the lock releases on both outcomes.
 */
export async function withFileLock<T>(
  filename: string,
  operation: () => Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  const lockPath = `${filename}.lock`
  const deadline = Date.now() + (options?.waitMs ?? DEFAULT_LOCK_WAIT_MS)
  const owner: LockOwner = {
    pid: process.pid,
    host: hostname(),
    boot: bootInstant(),
    token: randomBytes(8).toString('hex'),
  }
  let delay = LOCK_RETRY_INITIAL_MS
  let breaks = 0
  let broke: string | undefined
  for (;;) {
    try {
      await writeFile(lockPath, encodeOwner(owner), { mode: 0o600, flag: 'wx' })
      break
    } catch (error) {
      if (!await isLockContention(error, lockPath)) throw error
      const orphan = breaks < MAX_LOCK_BREAKS ? await orphanReason(lockPath) : undefined
      if (orphan !== undefined) {
        // Proof, not age: the recorded owner is gone, so the lock protects
        // nothing, and the next exclusive create still decides the winner
        // among however many contenders reached the same conclusion.
        breaks += 1
        broke = orphan
        await breakLock(lockPath)
        continue
      }
    }
    if (Date.now() >= deadline) {
      const cleared = broke === undefined ? '' : ` (an orphaned lock was cleared first: ${broke})`
      throw new Error(`atomic-write: timed out waiting for the writer lock at ${lockPath}${cleared}`)
    }
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS)
  }
  try {
    return await operation()
  } finally {
    await releaseLock(lockPath, owner)
  }
}
