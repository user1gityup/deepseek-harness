/**
 * Register an {@link AntigravityAdapter} for the `antigravity` provider route
 * on `ctx.llm`.
 *
 * The route answers by running the same `agy-headless.mjs` driver the
 * council's `agy-*` seats run, so it spends the same pool of signed-in Google
 * accounts and inherits the driver's leasing, hand-off and parking. It carries
 * no API key and no endpoint.
 *
 * Mounting the route is what makes Antigravity selectable wherever the harness
 * offers a model: the `/model` popup and composer selector, the deployment's
 * `agent-default-model`, and a subagent's `agentOptions`. Nothing routes to it
 * until one of those selects it.
 *
 * Connection facts resolve per request from the optional `llm-antigravity`
 * settings section layered over this plugin's `cordis.yml` entry, so a changed
 * seat or policy reaches the next call without a restart.
 * @module @deepseek-ai/dsh-llm-antigravity
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  AntigravityAdapter,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_PROMPT_CHARS,
  DEFAULT_TIMEOUT_MS,
  DRIVER_PROMPT_CEILING,
  TOOL_POLICIES,
} from './adapter.ts'
import type { AntigravityOptions, ToolPolicy } from './adapter.ts'

export {
  AntigravityAdapter,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_PROMPT_CHARS,
  DEFAULT_TIMEOUT_MS,
  DRIVER_PROMPT_CEILING,
  MODELS,
  TOOL_POLICIES,
  buildArgs,
  classifyFailure,
  failureLine,
  parseDriverOutput,
} from './adapter.ts'
export type { AntigravityAdapterOptions, AntigravityOptions, ToolPolicy } from './adapter.ts'
export { buildPrompt } from './prompt.ts'
export type { BuiltPrompt } from './prompt.ts'

/** Cordis plugin name. */
export const name = 'llm-antigravity'
/** Services required before this plugin can register its route. */
export const inject = ['llm']

const NS = settingsNamespace('llm-antigravity')

/** The single provider route this plugin owns. */
const PROVIDER = 'antigravity'

const MIN_TIMEOUT_MS = 1_000
const MIN_CONTEXT_WINDOW = 1_000
const MIN_PROMPT_CHARS = 1_000
/** `auto`, `pool`, `ide`, or a seat id in `agy-profile.mjs`'s charset. */
const SEAT_PATTERN = /^(?:auto|pool|ide|[a-z0-9][a-z0-9_-]{0,31})$/

/**
 * Plugin config, doubling as the `llm-antigravity` settings-section shape.
 *
 * Flat scalars with no materialized defaults: schemastery fills defaults into
 * nested objects before any code runs, and a nested default that fails its own
 * field stops the host from booting.
 */
export interface Config {
  /** Path to `agy-headless.mjs`; defaults to `~/.dsh/bin/agy-headless.mjs`. */
  driver?: string
  /** Which server answers: `auto` (default), `pool`, `ide`, or a seat id. */
  seat?: string
  /** Driver tool policy: `shared` (default), `web`, `read`, or `any`. */
  tools?: string
  /** Hard cap on one turn in milliseconds (default 420,000). */
  timeoutMs?: number
  /** Context capacity reported to the harness (default 32,000). */
  defaultContextWindow?: number
  /** Most prompt characters sent per call (default 28,000, at most 28,800). */
  maxPromptChars?: number
}

/** Schemastery schema for {@link Config}. */
export const Config: z<Config> = z.object({
  driver: z.string().description('Path to agy-headless.mjs.'),
  seat: z.string().description('Which server answers: auto, pool, ide, or a seat id.'),
  tools: z.string().description('Driver tool policy: shared, web, read, or any.'),
  timeoutMs: z.number().description('Hard cap on one turn, in milliseconds.'),
  defaultContextWindow: z.number().description('Context capacity reported to the harness.'),
  maxPromptChars: z.number().description('Most prompt characters sent per call.'),
})

/** @returns the path `scripts/install-agy-headless.mjs` installs the driver to. */
export function defaultDriver(): string {
  return join(homedir(), '.dsh', 'bin', 'agy-headless.mjs')
}

/**
 * Turn a settings snapshot into the facts one request needs.
 * @param config - the layered settings snapshot.
 * @returns resolved connection facts.
 */
export function resolveOptions(config: Config): AntigravityOptions {
  const driver = config.driver === undefined || config.driver.trim() === '' ? defaultDriver() : config.driver.trim()
  const seat = config.seat === undefined || config.seat.trim() === '' ? 'auto' : config.seat.trim()
  if (!SEAT_PATTERN.test(seat)) {
    throw new TypeError('llm-antigravity: seat must be auto, pool, ide, or a seat id')
  }
  const tools = config.tools === undefined || config.tools.trim() === '' ? 'shared' : config.tools.trim()
  if (!(TOOL_POLICIES as readonly string[]).includes(tools)) {
    throw new TypeError(`llm-antigravity: tools must be one of ${TOOL_POLICIES.join(', ')}`)
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS) {
    throw new TypeError(`llm-antigravity: timeoutMs must be at least ${String(MIN_TIMEOUT_MS)}`)
  }
  const defaultContextWindow = config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW
  if (!Number.isFinite(defaultContextWindow) || defaultContextWindow < MIN_CONTEXT_WINDOW) {
    throw new TypeError(`llm-antigravity: defaultContextWindow must be at least ${String(MIN_CONTEXT_WINDOW)}`)
  }
  const maxPromptChars = config.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS
  if (!Number.isInteger(maxPromptChars) || maxPromptChars < MIN_PROMPT_CHARS || maxPromptChars > DRIVER_PROMPT_CEILING) {
    throw new TypeError(
      `llm-antigravity: maxPromptChars must be an integer from ${String(MIN_PROMPT_CHARS)} to ${String(DRIVER_PROMPT_CEILING)}`,
    )
  }
  return { driver, seat, tools: tools as ToolPolicy, timeoutMs, defaultContextWindow, maxPromptChars }
}

/**
 * Mount the adapter and keep its facts current with the settings document.
 * @param ctx - the plugin's cordis context.
 * @param config - the composition entry's config.
 */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: AntigravityOptions | undefined
  const options = (): AntigravityOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveOptions(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-antigravity: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const adapter = new AntigravityAdapter({
    options,
    onUnsupportedTools: (message) => { ctx.logger.warn(message) },
  })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Antigravity', settingsNs: NS, settingsPath: [] },
  ])
  ctx.llm.registerAdapter([PROVIDER], adapter)

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    // Every fact is read per request, so a changed section needs no re-registration.
    onChange: () => {},
  })
}
