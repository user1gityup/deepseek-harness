/**
 * Share a finished run with the other machines, through the shared brain.
 *
 * A run record is written where it was made and, until now, stayed there: a run
 * saved on one machine was invisible on every other, so the same question was
 * answered twice. The shared brain is the store every machine already syncs, so
 * one line per run goes into its `dsh-runs.md` note as the run is filed.
 *
 * The note is created by the brain's own tooling (`.sync/brain-sync.mjs`, which
 * runs at every session start and DSH launch and also collects run records from
 * disk). This appends only when the note already exists, so the two writers
 * never disagree about its header, and nothing is lost when it does not: the
 * collection picks the record up from `$DSH_HOME/council-runs` afterwards.
 *
 * @module @deepseek-ai/dsh-tool-council/src/brain
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

/** The note every machine's runs are listed in. */
export const RUNS_NOTE = 'dsh-runs.md'

/** How long before a second append asks the brain to commit again. */
export const SYNC_INTERVAL_MS = 60_000

/** The fields a run needs to be shared; `RunRecord` satisfies it. */
export interface ShareableRun {
  readonly id: string
  readonly query: string
  readonly at: number
  readonly seatIds: readonly string[]
  readonly drafts: readonly { readonly text: string; readonly error?: string | undefined }[]
  readonly reviews: readonly unknown[]
  readonly amendments: number
}

/** Options for {@link shareRun}, all defaulted for production use. */
export interface ShareRunOptions {
  /** Brain directory, or false to share nothing. Defaults to the real brain. */
  brainDir?: string | false
  /** Machine name recorded on the line. Defaults to the host name. */
  machine?: string
  /** Clock for the sync throttle. */
  now?: number
  /** Whether to ask the brain to commit. Defaults to true. */
  sync?: boolean
}

/**
 * Asking the brain to commit what was just appended. A seam so a test can watch
 * the request without spawning a process.
 */
export const brainSyncSeam = {
  /**
   * Request a brain sync in the background.
   * @param brainDir - the brain directory to sync.
   */
  request(brainDir: string): void {
    const script = join(brainDir, '.sync', 'brain-sync.mjs')
    if (!existsSync(script)) return
    // Detached and ignored: a finished run must never wait on git, and the
    // brain's own lock decides what happens when two of these overlap.
    const child = spawn(process.execPath, [script, 'start', '--dir', brainDir, '--timeout', '6000'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
  },
}

let lastSyncAt = 0

/**
 * Locate the shared brain.
 * @param configured - explicit directory, or false to disable sharing.
 * @returns the directory, or undefined when sharing is off or it is absent.
 */
export function brainDirectory(configured?: string | false): string | undefined {
  if (configured === false) return undefined
  const fromEnv = process.env['DSH_BRAIN_DIR']
  const dir = configured
    ?? (fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.claude', 'shared-brain'))
  return existsSync(dir) ? dir : undefined
}

/**
 * Rewrite this machine's home folder as `~`.
 *
 * Notes are shared between machines with different user folders, and the
 * brain's pre-push gate refuses a note naming one. A run's query often does.
 * @param text - the line to clean.
 * @returns the line with home paths written as `~`.
 */
export function withoutHomePaths(text: string): string {
  const home = homedir()
  const backslash = home.split('/').join('\\')
  const slash = home.split('\\').join('/')
  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text
    .replace(new RegExp(escape(backslash), 'gi'), '~')
    .replace(new RegExp(escape(slash), 'gi'), '~')
}

/**
 * Render one run as the shared note's line. Kept byte-identical to the line
 * `brain-sync.mjs` writes for the same record, so a run collected from disk and
 * a run shared here are one line, not two.
 * @param record - the finished run.
 * @param machine - the machine the run was made on.
 * @returns the markdown line, home paths written as `~`.
 */
export function runLine(record: ShareableRun, machine: string): string {
  const at = new Date(record.at > 0 ? record.at : 0).toISOString().slice(0, 16).replace('T', ' ')
  const query = record.query.replace(/\s+/g, ' ').trim().slice(0, 160) || '(no query recorded)'
  const ok = record.drafts.filter(draft => draft.error === undefined && draft.text !== '').length
  const seats = record.seatIds.join(' ') || 'unknown'
  return withoutHomePaths(
    `- ${at}Z on ${machine} - "${query}" - seats: ${seats}; drafts ${ok}/${record.drafts.length};`
    + ` reviews ${record.reviews.length}; amendments ${record.amendments}`
    + ` <!-- dsh-run id=${record.id} machine=${machine} -->`,
  )
}

/**
 * Append one run to the shared note, once.
 * @param record - the finished run.
 * @param options - brain directory, machine, clock and sync control.
 * @returns whether a line was added.
 */
export function shareRun(record: ShareableRun, options: ShareRunOptions = {}): boolean {
  const dir = brainDirectory(options.brainDir)
  if (dir === undefined) return false
  const path = join(dir, RUNS_NOTE)
  if (!existsSync(path)) return false
  const key = `dsh-run id=${record.id}`
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return false
  }
  if (text.includes(key)) return false
  try {
    writeFileSync(path, `${text.replace(/\s*$/, '')}\n${runLine(record, options.machine ?? hostname())}\n`)
  } catch {
    // A run that answered must not fail because the shared note is read-only.
    return false
  }
  if (options.sync !== false) {
    const now = options.now ?? Date.now()
    if (now - lastSyncAt >= SYNC_INTERVAL_MS) {
      lastSyncAt = now
      try {
        brainSyncSeam.request(dir)
      } catch {
        // The next session start syncs anyway.
      }
    }
  }
  return true
}
