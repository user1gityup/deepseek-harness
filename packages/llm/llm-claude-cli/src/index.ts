/**
 * Register a {@link ClaudeCliAdapter} for the `claude-cli` provider route on
 * `ctx.llm`.
 *
 * The route answers by starting the Claude Code binary in print mode, so it
 * carries no API key and no endpoint: authentication is whatever that binary
 * is already signed in as, which is the whole point of the route existing.
 * That also fixes its limits. Print mode has no temperature, output cap, or
 * stop sequences, and its tool loop is internal to the CLI, so this provider
 * answers with text only — see `adapter.ts` for why approximating those knobs
 * would be worse than dropping them.
 *
 * Connection facts resolve per request from the optional `llm-claude-cli`
 * user-settings section layered over this plugin's `cordis.yml` entry, so a
 * changed command or timeout reaches the very next call without a restart,
 * while an in-flight run keeps the facts it started with.
 * @module @deepseek-ai/dsh-llm-claude-cli
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  ClaudeCliAdapter,
  DEFAULT_COMMAND,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_TIMEOUT_MS,
} from './adapter.ts'
import type { ClaudeCliOptions } from './adapter.ts'

export {
  ClaudeCliAdapter,
  DEFAULT_COMMAND,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_TIMEOUT_MS,
  buildArgs,
  classifyFailure,
} from './adapter.ts'
export type { ClaudeCliAdapterOptions, ClaudeCliOptions } from './adapter.ts'
export { executableCandidates, isWrongSpelling, resolveRealExecutable } from './executable.ts'
export { drainLines, parseLine, readUsage } from './events.ts'
export type { CliEvent } from './events.ts'
export { buildPrompt } from './prompt.ts'

/** Cordis plugin name. */
export const name = 'llm-claude-cli'
/** Services required before this plugin can register its route. */
export const inject = ['llm']

const NS = settingsNamespace('llm-claude-cli')

/** The single provider route this plugin owns. */
const PROVIDER = 'claude-cli'

/** Smallest timeout worth accepting; below this no real answer completes. */
const MIN_TIMEOUT_MS = 1_000

/** Smallest context window worth reporting; compaction needs room to work. */
const MIN_CONTEXT_WINDOW = 1_000

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-claude-cli` settings-section shape.
 *
 * Every field is a flat scalar with no default materialized into a nested
 * object. That is a hard constraint, not a style choice: schemastery fills
 * defaults into nested objects before any code runs, and a nested default that
 * fails its own required field stops the host from booting at all.
 */
export interface Config {
  /** Executable name or absolute path; defaults to `claude` on PATH. */
  command?: string
  /** Hard cap on one call's lifetime in milliseconds (default 600,000). */
  timeoutMs?: number
  /** Context capacity reported to the harness (default 200,000). */
  defaultContextWindow?: number
  /** Run the CLI with its own customizations disabled (default true). */
  safeMode?: boolean
  /**
   * Built-in CLI tools to allow, comma-separated; empty (the default) disables
   * all of them. Anything enabled here runs inside the CLI and never reaches
   * the harness session, so it spends tokens the user cannot see.
   */
  tools?: string
}

/** Schemastery schema for {@link Config}. */
export const Config: z<Config> = z.object({
  command: z.string().description('Claude Code executable name or absolute path.'),
  timeoutMs: z.number().description('Hard cap on one call, in milliseconds.'),
  defaultContextWindow: z.number().description('Context capacity reported to the harness.'),
  safeMode: z.boolean().description('Disable the CLI\'s own CLAUDE.md, skills, hooks, and MCP servers.'),
  tools: z.string().description('Comma-separated built-in CLI tools to allow; empty disables all.'),
})

/**
 * Turn a settings snapshot into the facts one request needs.
 *
 * Bounds are enforced here rather than in the schema because a settings
 * document can change under a running host: a rejected snapshot must leave the
 * previous good facts in place, which needs a throw the caller can catch.
 * @param config - the layered settings snapshot.
 * @returns resolved connection facts.
 */
export function resolveOptions(config: Config): ClaudeCliOptions {
  const command = config.command === undefined || config.command.trim() === ''
    ? DEFAULT_COMMAND
    : config.command.trim()
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS) {
    throw new TypeError(`llm-claude-cli: timeoutMs must be at least ${String(MIN_TIMEOUT_MS)}`)
  }
  const defaultContextWindow = config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW
  if (!Number.isFinite(defaultContextWindow) || defaultContextWindow < MIN_CONTEXT_WINDOW) {
    throw new TypeError(`llm-claude-cli: defaultContextWindow must be at least ${String(MIN_CONTEXT_WINDOW)}`)
  }
  return {
    command,
    timeoutMs,
    defaultContextWindow,
    safeMode: config.safeMode ?? true,
    tools: config.tools ?? '',
  }
}

/**
 * Mount the adapter and keep its facts current with the settings document.
 * @param ctx - the plugin's cordis context.
 * @param config - the composition entry's config.
 */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: ClaudeCliOptions | undefined
  const options = (): ClaudeCliOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveOptions(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing a beyond-schema bound: keep
      // serving the last good facts and say so once per bad snapshot.
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-claude-cli: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const adapter = new ClaudeCliAdapter({
    options,
    onUnsupportedTools: (message) => { ctx.logger.warn(message) },
  })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Claude Code CLI', settingsNs: NS, settingsPath: [] },
  ])
  ctx.llm.registerAdapter([PROVIDER], adapter)

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    // Nothing about this route is captured at registration: the command, the
    // timeout, and the reported window are all read per request, so a changed
    // section needs no re-registration to take effect.
    onChange: () => {},
  })
}
