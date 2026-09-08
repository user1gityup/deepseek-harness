/**
 * The sandbox POLICY home (`ctx.sandboxPolicy`): the single owner of the
 * deployment's sandbox fallbacks plus per-session resolution: the file-effect
 * {@link SandboxMode}, the `workspace-write` root, and the override kit (the
 * `sandbox/mode` event, its fold, and its write path, from `./session-mode.ts`).
 * Before each agent request, the owner also contributes the resolved policy to
 * the cache-safe runtime-context snapshot. The agent loop logs that snapshot as
 * model history, so replay reconstructs the same mode and root the enforcing
 * consumers resolve without rewriting the stable system prompt.
 *
 * Enforcing filesystem, one-shot bash, and terminal backends read the SAME
 * resolved policy here. The context describes that policy without inventorying
 * capabilities, while each backend retains its own enforcement dialect and each
 * tool owns its operation-specific denial and escalation guidance. The service
 * reads session state once at each operation boundary; executors and providers
 * remain session-free.
 *
 * @module @deepseek-ai/dsh-sandbox-policy
 */

import { resolve as resolvePath } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import { canonicalPath, type SandboxExecutionPolicy, type SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { effectiveSandboxMode, setSandboxMode } from './session-mode.ts'

export { SANDBOX_MODES, effectiveSandboxMode, setSandboxMode } from './session-mode.ts'

/** Resolve filesystem identity before lexical normalization can erase symlink-sensitive components. */
function resolveWorkspaceRoot(path: string): string {
  return resolvePath(canonicalPath(path))
}

/** Render the policy without claiming which capabilities are mounted. */
function renderPolicyContext(policy: SandboxExecutionPolicy): string {
  switch (policy.mode) {
    case 'read-only':
      return 'Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.'
    case 'workspace-write':
      return `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(policy.workspaceRoot)}. Some platform temporary areas may also be writable.`
    case 'danger-full-access':
      return 'Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.'
    /* v8 ignore next 4 -- SandboxMode is a typed same-process closed union; this branch is only the static exhaustiveness guard. */
    default: {
      const mode: never = policy.mode
      throw new Error(`unreachable sandbox mode: ${String(mode)}`)
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandboxPolicy: SandboxPolicyService
  }
}

/**
 * Plugin config: the deployment's sandbox default. All optional — `Config`
 * supplies the defaults (`mode: 'read-only'` is the fail-safe default; a
 * deployment that wants a workspace-writable agent opts in explicitly). The
 * runner choice is NOT here (it is the `ctx.sandbox` provider's config), nor
 * is any per-family knob: this is the one shared policy home.
 */
export interface Config {
  /** Require a session permission selection followed by a direct human `go` before writes. */
  requireWriteConfirmation?: boolean
  /** Refuse unconfined execution, including explicit escalation requests. */
  confinedOnly?: boolean
  /** Milliseconds in which a pending write approval may be confirmed. */
  writeApprovalTtlMs?: number
  /** File-sandbox mode a session starts from (default: `read-only`). */
  mode?: SandboxMode
  /**
   * Fallback root for agentless calls and sessions without a cwd (default:
   * `process.cwd()`). Normal agent calls use their session cwd instead.
   */
  workspaceRoot?: string
}

/** Inputs that select the sandbox policy for one capability call. */
export interface SandboxPolicyRequest {
  /** Calling session; its immutable cwd becomes the workspace boundary. */
  session?: Session
  /** Explicit approved mode override, which outranks session policy. */
  mode?: SandboxMode
}

/**
 * The sandbox-policy service (`ctx.sandboxPolicy`). Owns the deployment
 * default mode, fallback workspace root, and current request-time policy
 * section. Tool layers call {@link resolve} for each execution so a session's
 * mode log and immutable cwd travel together to every enforcing capability.
 */
export class SandboxPolicyService extends Service {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    requireWriteConfirmation: z.boolean().default(false),
    confinedOnly: z.boolean().default(false),
    writeApprovalTtlMs: z.number().min(1).default(900_000),
    mode: z.union(['read-only', 'workspace-write', 'danger-full-access'] as const).default('read-only'),
    // No schema default: process.cwd() is resolved in the constructor so the
    // stored root is always absolute regardless of how it was supplied.
    workspaceRoot: z.string(),
  })

  /** The deployment default mode — the fallback beneath a session override. */
  readonly defaultMode: SandboxMode
  /** The absolute `workspace-write` fallback root for calls without a session cwd. */
  readonly workspaceRoot: string
  /** Whether this deployment requires the two-step workspace write gate. */
  readonly requireWriteConfirmation: boolean
  /** Whether unconfined modes are forbidden in this deployment. */
  readonly confinedOnly: boolean
  private readonly writeApprovals = new WeakMap<Session, { expiresAt: number; confirmed: boolean; priorMessageIds: Set<string> }>()
  constructor(ctx: Context, config: Config) {
    super(ctx, 'sandboxPolicy')
    // schemastery (static Config) already filled `mode`; the cast records that
    // runtime fact. `workspaceRoot` has NO schema default, so its fallback to
    // the process cwd is real branching, resolved absolute either way.
    this.defaultMode = config.mode as SandboxMode
    this.workspaceRoot = resolveWorkspaceRoot(config.workspaceRoot ?? process.cwd())
    this.requireWriteConfirmation = config.requireWriteConfirmation === true
    this.confinedOnly = config.confinedOnly === true
    this.writeApprovalTtlMs = config.writeApprovalTtlMs as number
    ctx.on('session/event', (session, event) => {
      if (event.type === 'sandbox/mode' && event.data.mode !== 'workspace-write') this.writeApprovals.delete(session)
    })

    ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || !this.requireWriteConfirmation) return decision
      const pending = this.writeApprovals.get(agent.session)
      if (pending === undefined || pending.confirmed || Date.now() > pending.expiresAt) return decision
      if ((agent.session.header.delegationDepth ?? 0) !== 0) return decision
      const human = messages.filter(message => message.source.kind === 'user').at(-1)
      const text = human?.content.map(block => block.type === 'text' ? block.text : '').join('').trim()
      if (human !== undefined && !pending.priorMessageIds.has(human.id) && text?.toLowerCase() === 'go') {
        setSandboxMode(agent.session, 'workspace-write')
        pending.confirmed = true
      }
      return decision
    })

    ctx.inject(['systemPrompt'], (scope: Context) => {
      scope.systemPrompt.context({
        name: 'sandbox:policy',
        order: 110,
        text: (context) => {
          const session = context.agent?.session
          return session === undefined
            ? ''
            : this.requireWriteConfirmation && this.resolve({ session }).mode === 'read-only'
              ? 'Current DSH file policy: read-only. Workspace writes require the user to select workspace-write in this session\'s permission control, then send exactly "go" in this session. An approval alone, a go alone, or a per-file escalation cannot open this gate. Unconfined access is unavailable.'
              : renderPolicyContext(this.resolve({ session }))
        },
      })
    })
  }

  /**
   * Resolve the complete policy for one capability call. An approved explicit
   * mode outranks the session's last `sandbox/mode` event, which outranks the
   * deployment default. A session cwd is its workspace-write boundary; the
   * configured root is the fallback for agentless calls and sessions without a
   * cwd.
   * @param request - optional session and approved mode override.
   * @returns the fully resolved per-call mode and absolute workspace root.
   */
  resolve(request: SandboxPolicyRequest = {}): SandboxExecutionPolicy {
    const { session } = request
    let mode = request.mode ?? (session === undefined ? undefined : this.overrideOf(session)) ?? this.defaultMode
    if (this.confinedOnly && mode === 'danger-full-access') {
      if (request.mode !== undefined) throw new Error('Unconfined access is disabled; use the approved session workspace.')
      mode = 'read-only'
    }
    if (this.requireWriteConfirmation && mode !== 'read-only'
      && (session === undefined || this.writeApprovals.get(session)?.confirmed !== true)) mode = 'read-only'
    return {
      mode,
      workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot),
      ...session === undefined ? {} : { sessionId: session.id },
    }
  }

  private readonly writeApprovalTtlMs: number

  /**
   * Arm workspace writes from the human permission control; never enables writes by itself.
   * @param session - the exact top-level session being approved.
   */
  approveWorkspaceWrites(session: Session): void {
    if ((session.header.delegationDepth ?? 0) !== 0) throw new Error('Delegated agents cannot approve workspace writes.')
    setSandboxMode(session, 'read-only')
    const priorMessageIds = new Set<string>()
    for (const event of session.events) {
      if (event.type === 'user/message') priorMessageIds.add(event.data.id)
      if (event.type === 'agent/inbox/spliced') {
        for (const message of event.data.inserted) priorMessageIds.add(message.id)
      }
    }
    this.writeApprovals.set(session, { expiresAt: Date.now() + this.writeApprovalTtlMs, confirmed: false, priorMessageIds })
  }

  /**
   * Retire any pending or active workspace write grant.
   * @param session - session whose grant is being revoked.
   */
  revokeWorkspaceWrites(session: Session): void {
    this.writeApprovals.delete(session)
    setSandboxMode(session, 'read-only')
  }

  /**
   * Read the session override without applying the deployment default.
   * @param session - session whose log supplies the override.
   * @returns the last logged mode, or `undefined` without one.
   */
  overrideOf(session: Session): SandboxMode | undefined {
    return effectiveSandboxMode(session.events)
  }
}

export default SandboxPolicyService
