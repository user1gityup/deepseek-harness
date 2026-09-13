/**
 * The models the local Codex CLI offers, read from its own model cache.
 *
 * Codex refreshes `~/.codex/models_cache.json` from its service and marks each
 * entry `list` or `hide`; its own picker shows only the listed ones. The
 * council panel runs in the browser and cannot read that file, so the host
 * reads it and publishes the ids into the council settings section, the same
 * way it publishes measured CLI usage.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where Codex keeps its model cache. */
export const CODEX_MODELS_CACHE = join(homedir(), '.codex', 'models_cache.json')

/** One entry of the cache, as far as this reader cares. */
interface CacheEntry {
  slug?: unknown
  visibility?: unknown
}

/**
 * Read the model ids Codex's own picker would offer.
 * @param file - the cache file; defaults to Codex's own.
 * @returns listed model slugs in cache order, or an empty list when the file is
 *   missing or unreadable — a machine without Codex simply offers no choices.
 */
export function readCodexModels(file: string = CODEX_MODELS_CACHE): string[] {
  let body: unknown
  try {
    body = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  const models = (body as { models?: unknown }).models
  if (!Array.isArray(models)) return []
  const ids: string[] = []
  for (const entry of models as CacheEntry[]) {
    if (typeof entry.slug !== 'string' || entry.slug === '') continue
    if (entry.visibility === 'hide') continue
    if (!ids.includes(entry.slug)) ids.push(entry.slug)
  }
  return ids
}
