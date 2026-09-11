/** Package-owned invariant companion for the Antigravity adapter. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-llm-antigravity'

/** Cordis companion plugin name. */
export const name = 'llm-antigravity-invariant'
/** Invariant registry dependency. */
export const inject = ['invariants']

/** No runtime invariant: this adapter writes no durable state between calls. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant ownership. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
