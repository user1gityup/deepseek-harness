/**
 * An {@link LlmAdapter} that answers through Google Antigravity's agent.
 *
 * Antigravity ships no model API. What DSH has is `agy-headless.mjs`, the
 * driver the council's `agy-*` seats already run: prompt in on stdin, answer
 * out on stdout, and a pool of standalone language servers each signed in to
 * its own Google account, leased by tier weight and remaining quota with
 * hand-off when one drains. This adapter runs that same driver, so a model
 * picked here spends the same pool the council does and inherits its routing,
 * parking and IDE fallback rather than reimplementing any of it.
 *
 * There is no key in this path and nowhere to put one: authentication is
 * whatever each seat was signed in to by the user. What that gives up is
 * request control. The driver returns one finished answer, so the stream is a
 * single text block; there is no temperature, output cap or stop sequence;
 * and the harness tool set cannot be handed over, because Antigravity's agent
 * runs its own tools inside its own process. Those request fields are dropped,
 * and dropped tools are reported once per process.
 * @module @deepseek-ai/dsh-llm-antigravity/adapter
 */

import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { buildPrompt } from './prompt.ts'

/** The driver's own default turn cap, which is also the adapter's. */
export const DEFAULT_TIMEOUT_MS = 420_000

/**
 * Context capacity reported to the harness.
 *
 * Not a Gemini figure: the prompt this route can deliver is bounded by
 * {@link DEFAULT_MAX_PROMPT_CHARS}, so the window is reported small enough that
 * compaction keeps a session inside what actually reaches the agent.
 */
export const DEFAULT_CONTEXT_WINDOW = 32_000

/** Characters of prompt sent per call by default. */
export const DEFAULT_MAX_PROMPT_CHARS = 28_000

/**
 * The most prompt the driver accepts from this adapter: its 30000-character
 * ceiling less the 1100-character preamble of the `shared` policy, the longest
 * of the four, rounded down.
 */
export const DRIVER_PROMPT_CEILING = 28_800

/** Added to the driver's own `--timeout` before the adapter kills a driver that overran it. */
const OUTER_GRACE_MS = 15_000

/** Tool policies the driver accepts. */
export const TOOL_POLICIES = ['shared', 'web', 'read', 'any'] as const
/** One driver tool policy. */
export type ToolPolicy = typeof TOOL_POLICIES[number]

/** The model tiers `agentapi` resolves, under the ids the driver takes. */
export const MODELS: readonly { id: string; name: string; description: string }[] = [
  { id: 'flash_lite', name: 'Gemini Flash Lite (Antigravity)', description: 'Fastest Gemini tier on the Antigravity account pool' },
  { id: 'flash', name: 'Gemini Flash (Antigravity)', description: 'Balanced Gemini tier on the Antigravity account pool' },
  { id: 'pro', name: 'Gemini Pro (Antigravity)', description: 'Largest Gemini tier on the Antigravity account pool' },
]

/** Connection facts resolved per request from settings. */
export interface AntigravityOptions {
  /** Absolute path to `agy-headless.mjs`. */
  readonly driver: string
  /** `auto`, `pool`, `ide`, or one seat id. */
  readonly seat: string
  /** The driver's tool policy. */
  readonly tools: ToolPolicy
  /** The driver's `--timeout`. */
  readonly timeoutMs: number
  /** Context window reported to the harness. */
  readonly defaultContextWindow: number
  /** Most prompt characters sent per call. */
  readonly maxPromptChars: number
  /** Node executable that runs the driver; defaults to the host's own. */
  readonly nodePath?: string | undefined
}

/** Everything the adapter needs from its plugin host. */
export interface AntigravityAdapterOptions {
  /** Per-request connection facts; re-read on every call. */
  readonly options: () => AntigravityOptions
  /** Reported once when a request arrives carrying tools this seam cannot pass on. */
  readonly onUnsupportedTools?: ((message: string) => void) | undefined
}

/**
 * Build the driver argv for one request.
 * @param options - resolved connection facts.
 * @param model - the model tier.
 * @returns argv after the Node executable.
 */
export function buildArgs(options: AntigravityOptions, model: string): string[] {
  return [
    options.driver,
    '--model', model,
    '--tools', options.tools,
    '--seat', options.seat,
    '--timeout', String(options.timeoutMs),
    '--title', 'DSH',
    '--json',
  ]
}

/**
 * Classify a driver failure into the harness's shared error taxonomy.
 *
 * The driver reports failures as prose on stderr, naming each seat's failure
 * kind in parentheses when the whole pool failed. A skipped seat's
 * "quota check failed" is a transport fault, not an exhausted allowance, so
 * quota words only count next to an exhaustion verb.
 * @param text - stderr from the driver.
 * @returns a shared `HarnessError` code.
 */
export function classifyFailure(text: string): string {
  if (/\(quota\)|RESOURCE_EXHAUSTED|too many requests|\b(quota|rate limit)\b[^.\n]{0,40}\b(exceeded|exhausted|reached|depleted)\b/i.test(text)) return 'RATE_LIMIT'
  if (/\(signed-out\)|signed out|UNAUTHENTICATED|not logged into Antigravity|never signed in/i.test(text)) return 'AUTH'
  if (/timed out/i.test(text)) return 'TIMEOUT'
  return 'TRANSPORT'
}

/**
 * Read the answer out of the driver's `--json` output: the last line that is a
 * JSON object with a string `text`.
 * @param stdout - everything the driver printed.
 * @returns the answer, or undefined when no result line was printed.
 */
export function parseDriverOutput(stdout: string): string | undefined {
  const lines = stdout.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim()
    if (line === undefined || !line.startsWith('{')) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { text?: unknown }).text === 'string') {
        return (parsed as { text: string }).text
      }
    } catch {
      // Not the result line.
    }
  }
  return undefined
}

/**
 * The driver's own failure sentence: its last `agy-headless:` line, else the
 * last line of stderr.
 * @param stderr - everything the driver wrote to stderr.
 * @returns one line, at most 500 characters; empty when stderr was empty.
 */
export function failureLine(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
  const own = lines.filter(line => line.startsWith('agy-headless:')).at(-1)
  return (own ?? lines.at(-1) ?? '').replace(/^agy-headless:\s*/, '').slice(0, 500)
}

/** Adapter that runs one `agy-headless.mjs` turn per request. */
export class AntigravityAdapter extends LlmAdapter {
  readonly #options: () => AntigravityOptions
  readonly #onUnsupportedTools: ((message: string) => void) | undefined
  #warnedAboutTools = false

  /** @param options - per-request configuration and reporting seams. */
  constructor(options: AntigravityAdapterOptions) {
    super()
    this.#options = options.options
    this.#onUnsupportedTools = options.onUnsupportedTools
  }

  /** @inheritdoc */
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Antigravity' }
  }

  /** @inheritdoc */
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(MODELS.map(model => ({
      provider,
      id: model.id,
      name: model.name,
      description: model.description,
      inputModalities: ['text'] as const,
    })))
  }

  /** @inheritdoc */
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const known = MODELS.find(entry => entry.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: known?.name ?? model,
      ...known === undefined ? {} : { description: known.description },
      inputModalities: ['text'] as const,
      context: { contextWindow: this.#options().defaultContextWindow },
    })
  }

  /**
   * Report, once per process, that this seam dropped the request's tools.
   * @param request - the assembled request.
   */
  #noteDroppedTools(request: GenerateOptions): void {
    if (this.#warnedAboutTools) return
    if (request.tools === undefined || request.tools.length === 0) return
    this.#warnedAboutTools = true
    this.#onUnsupportedTools?.(
      `llm-antigravity: dropping ${String(request.tools.length)} tool schema(s); Antigravity's agent runs its own`
      + ' tools inside its own process and cannot accept the harness tool set. This provider answers with text only.',
    )
  }

  /** @inheritdoc */
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.#options()
    if (!MODELS.some(model => model.id === options.model)) {
      throw new LlmError(
        `llm-antigravity: unknown model "${options.model}"; Antigravity answers on ${MODELS.map(model => model.id).join(', ')}`,
        'INVALID_REQUEST',
      )
    }
    this.#noteDroppedTools(options)
    const prompt = buildPrompt(options.messages, options.system, connection.maxPromptChars)
    if (prompt.text === '') {
      throw new LlmError('llm-antigravity: the request carried no renderable content', 'INVALID_REQUEST')
    }
    const text = await this.#run(connection, options.model, prompt.text, options.signal)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  /**
   * Run the driver once and collect its answer.
   * @param connection - resolved facts.
   * @param model - the model tier.
   * @param prompt - the fitted prompt, written to the driver's stdin.
   * @param signal - the caller's cancellation.
   * @returns the answer text.
   */
  #run(connection: AntigravityOptions, model: string, prompt: string, signal: AbortSignal | undefined): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new LlmError('llm-antigravity: aborted', 'ABORTED'))
        return
      }
      let child: ChildProcessWithoutNullStreams
      try {
        // `shell: false` is the security boundary, and the prompt travels on
        // stdin rather than argv, so no part of it is ever parsed as a command.
        child = spawn(connection.nodePath ?? process.execPath, buildArgs(connection, model), {
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        reject(new LlmError(`llm-antigravity: could not start the driver: ${message}`, 'TRANSPORT', { cause: error }))
        return
      }
      let stdout = ''
      let stderr = ''
      let failure: LlmError | undefined
      const kill = (reason: LlmError): void => {
        failure ??= reason
        child.kill('SIGKILL')
      }
      // The driver enforces `--timeout` itself; this only catches one that
      // hangs past its own deadline.
      const timer = setTimeout(() => {
        kill(new LlmError(`llm-antigravity: timed out after ${String(connection.timeoutMs)}ms`, 'TIMEOUT'))
      }, connection.timeoutMs + OUTER_GRACE_MS)
      const onAbort = (): void => { kill(new LlmError('llm-antigravity: aborted', 'ABORTED')) }
      signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => { stdout += chunk })
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
        if (stderr.length > 64_000) stderr = stderr.slice(-64_000)
      })
      // A driver that fails before reading stdin reports through its exit code.
      child.stdin.on('error', () => {})
      child.once('error', (error: Error) => {
        failure ??= new LlmError(`llm-antigravity: ${error.message}`, 'TRANSPORT', { cause: error })
      })
      child.once('close', (code: number | null) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (failure !== undefined) {
          reject(failure)
          return
        }
        if (code !== 0) {
          const detail = failureLine(stderr)
          reject(new LlmError(
            `llm-antigravity: ${detail === '' ? `driver exited with code ${String(code)}` : detail}`,
            classifyFailure(stderr),
          ))
          return
        }
        const text = parseDriverOutput(stdout)
        if (text === undefined || text === '') {
          reject(new LlmError('llm-antigravity: the driver exited without an answer', 'TRANSPORT'))
          return
        }
        resolve(text)
      })
      child.stdin.end(prompt, 'utf8')
    })
  }
}
