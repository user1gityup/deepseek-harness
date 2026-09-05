/**
 * An {@link LlmAdapter} whose transport is a child process rather than an HTTP
 * endpoint.
 *
 * Every other adapter in the harness posts a request body to a provider. This
 * one starts the Claude Code binary in print mode and reads its `stream-json`
 * output, which means the call is authenticated by whatever that binary is
 * already logged in as. There is no API key in this path, and deliberately no
 * place to put one: the entire reason to route through the CLI is to use a
 * session the user has already established.
 *
 * What that buys in credentials it gives up in request control. Print mode
 * exposes no temperature, no output cap, and no stop sequences, so those
 * fields of `GenerateOptions` are dropped rather than approximated — silently
 * honouring three of five knobs would be worse than honouring none of them
 * visibly. Tools are dropped for the same reason: the CLI runs its own tool
 * loop internally and cannot be handed the harness's tool set through this
 * seam, so this adapter answers with text only and says so once per process.
 * @module @deepseek-ai/dsh-llm-claude-cli/adapter
 */

import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { executableCandidates, isWrongSpelling } from './executable.ts'
import { drainLines } from './events.ts'
import type { CliEvent } from './events.ts'
import { buildPrompt } from './prompt.ts'

/** Default binary name; resolved to a real executable on Windows before spawning. */
export const DEFAULT_COMMAND = 'claude'

/**
 * Default lifetime cap for one call.
 *
 * Generous on purpose. A main-agent turn carries the whole conversation, and
 * the CLI does its own retrying behind this timeout; a cap tight enough to
 * catch a hung child would also kill ordinary long answers.
 */
export const DEFAULT_TIMEOUT_MS = 600_000

/**
 * Context capacity reported when the model is not one of the known aliases.
 *
 * The CLI never states a window, so this is the harness's own figure for
 * compaction decisions rather than anything the provider confirmed.
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/** One channel of assembled output. */
type Channel = 'text' | 'reasoning'

/** The aliases the CLI accepts for "the current model of this size". */
const ALIAS_MODELS: readonly { id: string; name: string; description: string }[] = [
  { id: 'opus', name: 'Claude Opus (CLI)', description: 'Largest model on the signed-in Claude Code session' },
  { id: 'sonnet', name: 'Claude Sonnet (CLI)', description: 'Balanced model on the signed-in Claude Code session' },
  { id: 'haiku', name: 'Claude Haiku (CLI)', description: 'Fastest model on the signed-in Claude Code session' },
]

/** Connection facts resolved per request from settings. */
export interface ClaudeCliOptions {
  /** Executable name or absolute path. */
  readonly command: string
  /** Hard cap on one child's lifetime. */
  readonly timeoutMs: number
  /** Context window reported for models with no known figure. */
  readonly defaultContextWindow: number
  /**
   * Start the CLI with its customizations disabled.
   *
   * On by default, and the difference is not cosmetic: without it every call
   * loads the user's own CLAUDE.md, skills, hooks, and MCP servers into a
   * request the harness already built a system prompt for, which both changes
   * the answer and bills the extra context.
   */
  readonly safeMode: boolean
  /**
   * Built-in CLI tools to allow, comma-separated; empty disables all of them.
   *
   * Empty is the honest default for this seam. The harness cannot see results
   * from tools the CLI runs on its own, so anything enabled here happens
   * off-book: it spends tokens and touches the filesystem without appearing in
   * the session the user is reading.
   */
  readonly tools: string
  /** Extra environment for the child, layered over the parent's. */
  readonly env?: Readonly<Record<string, string>> | undefined
}

/** Everything the adapter needs from its plugin host. */
export interface ClaudeCliAdapterOptions {
  /** Per-request connection facts; re-read on every call. */
  readonly options: () => ClaudeCliOptions
  /** Reported once when a request arrives carrying tools this seam cannot pass on. */
  readonly onUnsupportedTools?: ((message: string) => void) | undefined
}

/** One child's captured failure, kept separate from its output stream. */
interface ChildFailure {
  readonly message: string
  readonly code: string
}

/** What one parsed event changed, beside the chunks it produced. */
interface Applied {
  readonly chunks: readonly StreamChunk[]
  readonly sawDelta: boolean
  readonly usage?: TokenUsage
  readonly resultText?: string
  readonly resultError?: string
}

/** Mutable per-run assembly state shared by the event handler. */
interface RunState {
  readonly openIndex: (channel: Channel) => number
  readonly parts: Record<Channel, string>
  sawDelta: boolean
}

/**
 * Start a child, resolving only once the process is actually running.
 *
 * `spawn` reports a bad executable two different ways — synchronously for a
 * Windows batch shim, asynchronously as an `error` event otherwise — and both
 * have to be caught before the caller commits to this candidate spelling.
 * @param command - one candidate spelling.
 * @param args - fully formed argv.
 * @param env - extra environment layered over the parent's.
 * @returns the running child.
 */
function startChild(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> | undefined,
): Promise<ChildProcessWithoutNullStreams> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      // `shell: false` is the security boundary: the prompt is argv data, never
      // a fragment of a command line a shell would re-parse.
      child = spawn(command, [...args], {
        shell: false,
        windowsHide: true,
        ...env === undefined ? {} : { env: { ...process.env, ...env } },
      })
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    const onError = (error: Error): void => {
      child.removeListener('spawn', onSpawn)
      reject(error)
    }
    const onSpawn = (): void => {
      child.removeListener('error', onError)
      resolve(child)
    }
    child.once('error', onError)
    child.once('spawn', onSpawn)
  })
}

/**
 * Build the argv for one request.
 * @param options - resolved connection facts.
 * @param request - the assembled harness request.
 * @param prompt - the flattened conversation.
 * @returns argv after the executable.
 */
export function buildArgs(
  options: ClaudeCliOptions,
  request: GenerateOptions,
  prompt: string,
): string[] {
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--model', request.model,
    // An empty list is the CLI's own spelling for "no built-in tools".
    '--tools', options.tools,
    '--strict-mcp-config',
  ]
  if (options.safeMode) args.push('--safe-mode')
  if (request.system !== undefined && request.system !== '') {
    args.push('--system-prompt', request.system)
  }
  args.push(prompt)
  return args
}

/**
 * Classify a CLI failure into the harness's shared error taxonomy.
 *
 * The CLI reports failures as prose, so this reads the prose. It is a routing
 * hint for retry policy, not a diagnosis: an unmatched failure lands on
 * `TRANSPORT`, which the harness treats as retryable transport trouble.
 * @param text - the failure text, including stderr.
 * @returns a shared `HarnessError` code.
 */
export function classifyFailure(text: string): string {
  if (/rate limit|usage limit|quota|429/i.test(text)) return 'RATE_LIMIT'
  if (/not logged in|please log in|authenticat|unauthoriz|invalid api key|401|403/i.test(text)) return 'AUTH'
  if (/overloaded|529|502|503|internal server/i.test(text)) return 'SERVER'
  return 'TRANSPORT'
}

/** Adapter that streams one `claude --print` run per request. */
export class ClaudeCliAdapter extends LlmAdapter {
  readonly #options: () => ClaudeCliOptions
  readonly #onUnsupportedTools: ((message: string) => void) | undefined
  #warnedAboutTools = false

  /** @param options - per-request configuration and reporting seams. */
  constructor(options: ClaudeCliAdapterOptions) {
    super()
    this.#options = options.options
    this.#onUnsupportedTools = options.onUnsupportedTools
  }

  /** @inheritdoc */
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Claude Code CLI' }
  }

  /** @inheritdoc */
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(ALIAS_MODELS.map(model => ({
      provider,
      id: model.id,
      name: model.name,
      description: model.description,
      inputModalities: ['text'] as const,
    })))
  }

  /** @inheritdoc */
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const known = ALIAS_MODELS.find(entry => entry.id === model)
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
   *
   * Once rather than per request because the harness sends its whole tool set
   * on every turn: a per-call warning would be one line of noise per message
   * for the entire session, and the fact does not change between them.
   * @param request - the assembled request.
   */
  #noteDroppedTools(request: GenerateOptions): void {
    if (this.#warnedAboutTools) return
    if (request.tools === undefined || request.tools.length === 0) return
    this.#warnedAboutTools = true
    this.#onUnsupportedTools?.(
      `llm-claude-cli: dropping ${String(request.tools.length)} tool schema(s); the Claude Code CLI runs its own`
      + ' tool loop and cannot accept the harness tool set through print mode. This provider answers with text only.',
    )
  }

  /** @inheritdoc */
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.#options()
    this.#noteDroppedTools(options)
    const prompt = buildPrompt(options.messages)
    if (prompt === '') {
      throw new LlmError('llm-claude-cli: the request carried no renderable content', 'INVALID_REQUEST')
    }
    const args = buildArgs(connection, options, prompt)

    let child: ChildProcessWithoutNullStreams | undefined
    for (const candidate of executableCandidates(connection.command)) {
      try {
        child = await startChild(candidate, args, connection.env)
        break
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // ENOENT means this spelling does not exist and EINVAL means Node
        // refused a batch shim; either way the next candidate deserves a turn.
        if (isWrongSpelling(message)) continue
        throw new LlmError(`llm-claude-cli: could not start ${candidate}: ${message}`, 'TRANSPORT', { cause: error })
      }
    }
    if (child === undefined) {
      throw new LlmError(
        `llm-claude-cli: ${connection.command} is not installed or not on PATH`,
        'TRANSPORT',
      )
    }

    yield* this.#pump(child, connection, options.signal)
  }

  /**
   * Read one running child to completion, emitting harness chunks as it goes.
   * @param child - the started process.
   * @param connection - resolved facts, for the timeout.
   * @param signal - the caller's cancellation.
   * @returns the chunk stream for this run.
   */
  async *#pump(
    child: ChildProcessWithoutNullStreams,
    connection: ClaudeCliOptions,
    signal: AbortSignal | undefined,
  ): AsyncIterable<StreamChunk> {
    let stderr = ''
    let failure: ChildFailure | undefined
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr += chunk })

    const kill = (reason: ChildFailure): void => {
      failure ??= reason
      child.kill('SIGKILL')
    }
    const timer = setTimeout(
      () => { kill({ message: `timed out after ${String(connection.timeoutMs)}ms`, code: 'TIMEOUT' }) },
      connection.timeoutMs,
    )
    const onAbort = (): void => { kill({ message: 'aborted', code: 'ABORTED' }) }
    signal?.addEventListener('abort', onAbort, { once: true })

    // Blocks open lazily and close in the order they opened, so a run that
    // produced only text never emits an empty reasoning block.
    const opened: Channel[] = []
    const state: RunState = {
      openIndex: (channel) => {
        const held = opened.indexOf(channel)
        if (held !== -1) return held
        opened.push(channel)
        return opened.length - 1
      },
      parts: { text: '', reasoning: '' },
      sawDelta: false,
    }
    let usage: TokenUsage | undefined
    let resultText = ''
    let resultError: string | undefined

    const absorb = (applied: Applied): readonly StreamChunk[] => {
      state.sawDelta = applied.sawDelta
      if (applied.usage !== undefined) usage = applied.usage
      if (applied.resultText !== undefined) resultText = applied.resultText
      if (applied.resultError !== undefined) resultError = applied.resultError
      return applied.chunks
    }

    try {
      let buffer = ''
      child.stdout.setEncoding('utf8')
      for await (const chunk of child.stdout as AsyncIterable<string>) {
        const drained = drainLines(buffer + chunk)
        buffer = drained.rest
        for (const event of drained.events) yield* absorb(this.#apply(event, state))
      }
      // A final line with no trailing newline still has to be read.
      for (const event of drainLines(`${buffer}\n`).events) yield* absorb(this.#apply(event, state))

      const code = await new Promise<number | null>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve(child.exitCode)
          return
        }
        child.once('close', (exit: number | null) => { resolve(exit) })
      })

      if (failure !== undefined) {
        throw new LlmError(`llm-claude-cli: ${failure.message}`, failure.code)
      }

      // The terminal `result` line carries the whole answer. When no deltas
      // arrived — an older CLI, or one that declined partial messages — it is
      // the only content there is, so it becomes the response rather than a
      // duplicate of it.
      if (!state.sawDelta && state.parts.text === '' && resultText !== '' && resultError === undefined) {
        const index = state.openIndex('text')
        state.parts.text = resultText
        yield { type: 'block-start', index, blockType: 'text' }
        yield { type: 'text-delta', index, text: resultText }
      }

      if (resultError !== undefined || (code !== 0 && code !== null)) {
        const detail = resultError ?? stderr.trim()
        const text = detail === '' ? `exited with code ${String(code)}` : detail
        throw new LlmError(`llm-claude-cli: ${text.slice(0, 500)}`, classifyFailure(`${text} ${stderr}`))
      }

      // Ascending, so blocks close in the order they opened. The CLI's stop
      // events are not mirrored here, so every open block closes at the end;
      // closing them backwards would hand the assembler its indices in an
      // order no other adapter produces.
      for (let index = 0; index < opened.length; index += 1) {
        const channel = opened[index]
        if (channel === undefined) continue
        const block: ContentBlock = channel === 'text'
          ? { type: 'text', text: state.parts.text }
          : { type: 'reasoning', text: state.parts.reasoning }
        yield { type: 'block-end', index, block }
      }
      if (usage !== undefined) yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      // A consumer that stops iterating early lands here; the child would
      // otherwise keep running and keep spending.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }

  /**
   * Turn one parsed CLI event into harness chunks and state updates.
   * @param event - the parsed line.
   * @param state - the run's open blocks and accumulated text.
   * @returns chunks to emit plus whatever the event changed.
   */
  #apply(event: CliEvent, state: RunState): Applied {
    if (event.kind === 'delta') {
      const first = state.parts[event.channel] === ''
      const index = state.openIndex(event.channel)
      const chunks: StreamChunk[] = []
      if (first) chunks.push({ type: 'block-start', index, blockType: event.channel })
      state.parts[event.channel] += event.text
      chunks.push(event.channel === 'text'
        ? { type: 'text-delta', index, text: event.text }
        : { type: 'reasoning-delta', index, text: event.text })
      return { chunks, sawDelta: true }
    }
    if (event.kind === 'assistant') {
      // Complete messages arrive alongside deltas when both are available;
      // taking their content too would emit the answer twice.
      return {
        chunks: [],
        sawDelta: state.sawDelta,
        ...event.usage === undefined ? {} : { usage: event.usage },
      }
    }
    return {
      chunks: [],
      sawDelta: state.sawDelta,
      ...event.usage === undefined ? {} : { usage: event.usage },
      resultText: event.text,
      ...event.isError ? { resultError: event.failure ?? event.text } : {},
    }
  }
}
