/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-quota-antigravity`.
 * @module @deepseek-ai/dsh-quota-antigravity/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-quota-antigravity'

/** Cordis companion plugin name. */
export const name = 'quota-antigravity-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: normalized external quota is published through the
 * settings provider, which owns revisions and notifications. Reader deadlines,
 * serialization and cancellation are operation-local and checked by subprocess
 * and lifecycle tests rather than an invented cross-plugin event relationship.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
