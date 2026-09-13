/**
 * Journal of seat answers, so an aborted run resumes instead of starting over.
 *
 * A pipeline saves its state only when a stage returns, and the standalone
 * council files its record only when the run finishes. A run cut off part way
 * — the host restarted, the window closed — used to lose every answer it had
 * already collected. Measured 2026-09-12: a council stage was killed by a host
 * restart fourteen minutes and two full rounds in, and the only way back was
 * to ask every seat everything again.
 *
 * So while a run is in flight, every successful seat answer is appended here
 * under the run's journal id, keyed by the seat's routing and the exact prompt.
 * When the run is entered again under the same id, a call whose prompt is
 * identical gets the recorded answer back without asking the seat. A later
 * round's prompt embeds the earlier answers, so as long as those came back from
 * the journal its prompts match too, and the resumed run walks through the work
 * already done for free and pays only for what was missing.
 *
 * Only answers are kept. An error or an empty reply is never recorded: those
 * are exactly the calls a resume should make again.
 *
 * Lines are appended one per answer, so a crash mid-write costs at most the
 * answer being written; a torn last line is skipped on load.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SeatConfig, SeatReply } from './seats.ts'

/** How many run journals are kept before the oldest are pruned. */
export const JOURNAL_HISTORY = 20

/**
 * How long a recorded answer may be handed back. A resume happens within the
 * hour; a question asked again tomorrow deserves a fresh answer.
 */
export const JOURNAL_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** One run's journal, as loaded for the run in flight. */
export interface Journal {
  readonly runId: string
  readonly path: string
  readonly entries: Map<string, SeatReply>
  /** Answers handed back from the journal during this call. */
  hits: number
}

const scope = new AsyncLocalStorage<Journal>()

/** Where run journals live. */
export function journalDirectory(): string {
  return join(homedir(), '.dsh', 'council-runs', 'journal')
}

/**
 * A journal id for a run that has no id of its own until it finishes — the
 * standalone council, which a model re-calls with the same question after an
 * abort. The same question maps to the same journal.
 * @param question - the question the run answers.
 * @returns a 32-character hex id.
 */
export function journalIdFor(question: string): string {
  return createHash('sha256').update(question).digest('hex').slice(0, 32)
}

/**
 * The key one call is recorded under.
 *
 * The routing is part of it: the same prompt re-aimed at a different model is
 * a different question. Shared memory is not — the digest is refreshed at every
 * host start, and a resume after a restart must still match.
 * @param seat - the seat asked.
 * @param prompt - the prompt, before any memory is added.
 * @returns a hex digest.
 */
export function journalKey(seat: SeatConfig, prompt: string): string {
  const routing = [seat.id, seat.transport, seat.command ?? '', seat.model ?? '', seat.baseUrl ?? '']
  return createHash('sha256').update(JSON.stringify([...routing, prompt])).digest('hex')
}

/**
 * Load a run's journal, creating nothing until the first answer is recorded.
 * @param runId - the run's journal id.
 * @param directory - where journals live.
 * @param now - epoch ms, for the age limit.
 * @returns the journal, or undefined for an id that cannot name a file.
 */
export function openJournal(runId: string, directory: string = journalDirectory(), now: number = Date.now()): Journal | undefined {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(runId)) return undefined
  const path = join(directory, `${runId}.jsonl`)
  const entries = new Map<string, SeatReply>()
  let raw = ''
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    raw = ''
  }
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const entry = JSON.parse(line) as { key?: unknown; at?: unknown; reply?: Partial<SeatReply> }
      const reply = entry.reply
      if (typeof entry.key !== 'string' || reply === undefined || typeof reply.seat !== 'string' || typeof reply.text !== 'string') continue
      if (typeof entry.at !== 'number' || now - entry.at > JOURNAL_MAX_AGE_MS) continue
      entries.set(entry.key, {
        seat: reply.seat,
        text: reply.text,
        ms: typeof reply.ms === 'number' ? reply.ms : 0,
        ...Array.isArray(reply.citedUrls) ? { citedUrls: reply.citedUrls } : {},
      })
    } catch {
      // A torn line from a write the crash interrupted: that one answer is asked again.
    }
  }
  return { runId, path, entries, hits: 0 }
}

/**
 * Run work with its journal in scope.
 * @param journal - the run's journal; undefined runs the work unjournalled.
 * @param work - the run.
 * @returns whatever the work returns.
 */
export async function withJournal<T>(journal: Journal | undefined, work: () => Promise<T>): Promise<T> {
  if (journal === undefined) return await work()
  return await scope.run(journal, work)
}

/**
 * The recorded answer to this exact call, when the run in scope has one.
 * @param seat - the seat about to be asked.
 * @param prompt - the prompt about to be sent.
 * @returns the answer, or undefined when the seat has to be asked.
 */
export function recallReply(seat: SeatConfig, prompt: string): SeatReply | undefined {
  const journal = scope.getStore()
  if (journal === undefined) return undefined
  const reply = journal.entries.get(journalKey(seat, prompt))
  if (reply !== undefined) journal.hits += 1
  return reply
}

/**
 * Record an answer for the run in scope.
 *
 * Never throws: a seat that answered must not fail because its answer could
 * not be journalled. Usage is left out on purpose — a recalled answer costs
 * nothing, and carrying the original cost would bill it twice.
 * @param seat - the seat that answered.
 * @param prompt - the prompt it was sent.
 * @param reply - what came back.
 */
export function recordReply(seat: SeatConfig, prompt: string, reply: SeatReply): void {
  const journal = scope.getStore()
  if (journal === undefined || reply.error !== undefined || reply.text.trim() === '') return
  const key = journalKey(seat, prompt)
  const kept: SeatReply = {
    seat: reply.seat,
    text: reply.text,
    ms: reply.ms,
    ...reply.citedUrls === undefined ? {} : { citedUrls: reply.citedUrls },
  }
  journal.entries.set(key, kept)
  try {
    const directory = join(journal.path, '..')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    appendFileSync(journal.path, `${JSON.stringify({ key, at: Date.now(), reply: kept })}\n`, { mode: 0o600 })
    prune(directory)
  } catch {
    // The answer is still in memory for this call; only a later resume loses it.
  }
}

/**
 * Delete a run's journal, once the run is finished or abandoned.
 * @param runId - the run's journal id.
 * @param directory - where journals live.
 */
export function discardJournal(runId: string, directory: string = journalDirectory()): void {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(runId)) return
  try {
    rmSync(join(directory, `${runId}.jsonl`), { force: true })
  } catch {
    // Pruning removes it later.
  }
}

/**
 * The line a report carries when answers came back from the journal.
 * @param journal - the journal the call ran with.
 * @returns the note, or '' when nothing was reused.
 */
export function resumedNote(journal: Journal | undefined): string {
  return journal === undefined || journal.hits === 0
    ? ''
    : `\n\n_Resumed: ${String(journal.hits)} seat answer(s) came back from this run's journal — not asked or paid for again._`
}

/** Drop the oldest journals past {@link JOURNAL_HISTORY}. */
function prune(directory: string): void {
  let names: readonly { name: string; at: number }[]
  try {
    names = readdirSync(directory)
      .filter(name => name.endsWith('.jsonl'))
      .map((name) => {
        let at = 0
        try {
          at = statSync(join(directory, name)).mtimeMs
        } catch {
          at = 0
        }
        return { name, at }
      })
      .sort((left, right) => right.at - left.at)
  } catch {
    return
  }
  for (const entry of names.slice(JOURNAL_HISTORY)) {
    try {
      rmSync(join(directory, entry.name), { force: true })
    } catch {
      // Not worth failing a run over.
    }
  }
}
