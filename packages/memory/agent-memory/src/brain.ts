/**
 * Remembered facts, shared with the other machines through the shared brain.
 *
 * The memory domain is one machine's database, so a fact remembered on one
 * machine never reached the next. The brain is the store every machine syncs:
 * each entry becomes one line in its `dsh-memory.md` note, and the lines other
 * machines wrote come back into this machine's digest, which is what every
 * agent and council seat reads.
 *
 * The note is created by the brain's own tooling (`.sync/brain-sync.mjs`, which
 * also collects facts straight from the digest at every session start and DSH
 * launch). This appends only when the note exists, so the two writers never
 * disagree about its header.
 *
 * @module @deepseek-ai/dsh-agent-memory/src/brain
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import type { MemoryEntry, MemoryKind } from './spec.ts'
import { memoryKinds } from './spec.ts'

/** The note every machine's remembered facts are listed in. */
export const FACTS_NOTE = 'dsh-memory.md'

/** Most foreign facts rendered into one digest. */
export const SHARED_LIMIT = 200

/** One fact another machine remembered. */
export interface SharedFact {
  /** DSH's id for the fact, derived from its text. */
  id: string
  kind: MemoryKind
  /** The fact as the digest rendered it, tags included. */
  body: string
  /** Machine it was remembered on. */
  machine: string
}

/** Options for {@link shareFacts}. */
export interface ShareFactsOptions {
  /** Brain directory, or false to keep memory on this machine only. */
  brainDir?: string | false
  /** Machine name recorded on new lines. Defaults to the host name. */
  machine?: string
}

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
 * Rewrite this machine's home folder as `~`, which shared notes require.
 * @param text - the line to clean.
 * @returns the line with home paths written as `~`.
 */
export function withoutHomePaths(text: string): string {
  const home = homedir()
  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text
    .replace(new RegExp(escape(home.split('/').join('\\')), 'gi'), '~')
    .replace(new RegExp(escape(home.split('\\').join('/')), 'gi'), '~')
}

/**
 * The digest's rendering of one entry: the text, and its tags when it has any.
 * @param entry - the remembered item.
 * @returns the bullet body, without the leading dash.
 */
export function factBody(entry: MemoryEntry): string {
  return entry.tags.length === 0 ? entry.text : `${entry.text} _(${entry.tags.join(', ')})_`
}

/**
 * The id a fact carries in the shared note.
 *
 * Derived from the text with home folders written as `~`, never from the raw
 * text, and never from the entry's own id: a fact naming the machine it was
 * written on is the same fact everywhere, but its raw text differs per machine.
 * Hashing first gave each machine its own id, the dedupe missed, and one fact
 * appeared once per machine - identical on screen, because the line is
 * normalised before it is written. Same algorithm as `idFor` in the memory
 * tools and `dshFactId` in the brain's own tooling, so all three agree.
 * @param text - the remembered text.
 * @returns the shared id.
 */
export function sharedFactId(text: string): string {
  const normalized = withoutHomePaths(text)
  let hash = 0
  for (let index = 0; index < normalized.length; index += 1) hash = (hash * 31 + normalized.charCodeAt(index)) | 0
  return `m${(hash >>> 0).toString(36)}`
}

/**
 * Render one entry as the shared note's line. Kept byte-identical to the line
 * `brain-sync.mjs` writes when it collects the same fact from the digest.
 * @param entry - the remembered item.
 * @param machine - the machine it was remembered on.
 * @returns the markdown line.
 */
export function factLine(entry: MemoryEntry, machine: string): string {
  return withoutHomePaths(
    `- [${entry.kind}] ${factBody(entry)} - remembered on ${machine}`
    + ` <!-- dsh-fact id=${sharedFactId(entry.text)} machine=${machine} -->`,
  )
}

const LINE = /^-\s+\[([a-z]+)\]\s+(.*?)\s+-\s+remembered on\s+(\S+)\s+<!--\s*dsh-fact id=(\S+)/

/**
 * Read the facts a shared note holds.
 * @param text - the note's content.
 * @returns one entry per recognised line, in file order.
 */
export function parseSharedFacts(text: string): readonly SharedFact[] {
  const facts: SharedFact[] = []
  for (const raw of text.split(/\r?\n/)) {
    const match = LINE.exec(raw.trim())
    if (match === null) continue
    const [, kind, body, machine, id] = match
    if (kind === undefined || body === undefined || machine === undefined || id === undefined) continue
    if (!(memoryKinds as readonly string[]).includes(kind)) continue
    facts.push({ id, kind: kind as MemoryKind, body, machine })
  }
  return facts
}

/**
 * Put this machine's entries in the shared note, and read back what the other
 * machines put there.
 * @param entries - this machine's remembered items.
 * @param options - brain directory and machine name.
 * @returns the facts only other machines hold, newest lines last.
 */
export function shareFacts(
  entries: readonly MemoryEntry[],
  options: ShareFactsOptions = {},
): readonly SharedFact[] {
  const dir = brainDirectory(options.brainDir)
  if (dir === undefined) return []
  const path = join(dir, FACTS_NOTE)
  if (!existsSync(path)) return []
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const machine = options.machine ?? hostname()
  const fresh = entries
    .filter(entry => !text.includes(`dsh-fact id=${sharedFactId(entry.text)}`))
    .map(entry => factLine(entry, machine))
  if (fresh.length > 0) {
    const next = `${text.replace(/\s*$/, '')}\n${fresh.join('\n')}\n`
    try {
      writeFileSync(path, next)
      text = next
    } catch {
      // A note that cannot be written costs the sharing, not the session.
    }
  }
  const mine = new Set(entries.map(entry => sharedFactId(entry.text)))
  return parseSharedFacts(text).filter(fact => !mine.has(fact.id)).slice(-SHARED_LIMIT)
}
