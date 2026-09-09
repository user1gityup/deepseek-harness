/**
 * Boot the plugin the way the loader does, and exercise the panel's refresh.
 *
 * The case that matters is a refresh requested while a read is still in flight,
 * which is what a click during the boot read is. The second test holds that
 * first read open on purpose rather than letting it settle: letting it settle
 * is the easy path, and it passes whether or not the request is honoured.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import FileSettingsProvider from '../../../settings/settings-file/src/index.ts'
import * as quota from '../src/index.ts'
import { readQuota } from '../src/reading.ts'
vi.mock('../src/reading.ts', () => ({ readQuota: vi.fn() }))

const rows = [{ id: 'weekly', group: 'Gemini Models', label: 'Weekly', remaining: 89.4, resetsAt: null, window: 'weekly', note: null }]

/** Write the loader config the plugin boots from. */
async function writeConfig(root: string): Promise<void> {
  // The settings path is absolute on purpose: `FileSettingsProvider` resolves a
  // relative one against the process working directory rather than the loader's
  // `baseUrl`, so the bare `settings.yaml` this spec used to carry was written
  // into the repository root on every run, holding the fake 89.4 reading.
  await writeFile(
    join(root, 'cordis.yml'),
    [
      "- name: '@deepseek-ai/dsh-settings-file'",
      '  config:',
      `    path: ${JSON.stringify(join(root, 'settings.yaml'))}`,
      "- name: '@deepseek-ai/dsh-quota-antigravity'",
      '  config:',
      '    refreshIntervalMs: 0',
      '',
    ].join('\n'),
  )
}

/** Boot the loader against `root` with the reader plugin registered. */
async function boot(root: string): Promise<Context> {
  const context = new Context()
  await writeConfig(root)
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-settings-file', FileSettingsProvider],
    ['@deepseek-ai/dsh-quota-antigravity', quota],
  ])
  // Only the loader's `import` is exercised here, so the stub carries none of
  // ModuleLoaderV2's other members; a direct cast is rejected for that gap.
  context.loader.internal = { version: 'v2', async import(name: string) { if (!modules.has(name)) throw Error(name); return modules.get(name) } } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(root, 'cordis.yml')).href } })
  await context.loader.await()
  return context
}

it('boots the YAML reader, publishes quota, retains failed captures and disposes its namespace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'antigravity-composition-'))
  vi.mocked(readQuota).mockReset()
  vi.mocked(readQuota).mockResolvedValue(rows)
  const context = await boot(root)
  try {
    const snapshot = () => context.settings.describe().find(row => row.ns === quota.ANTIGRAVITY_QUOTA_NAMESPACE)
    await vi.waitFor(() => expect(JSON.stringify(snapshot())).toContain('89.4'))
    vi.mocked(readQuota).mockRejectedValue(new Error('provider unavailable'))
    await context.settings.update(quota.ANTIGRAVITY_QUOTA_NAMESPACE, { refreshRequestedAt: 1 })
    await vi.waitFor(() => expect(JSON.stringify(snapshot())).toContain('failed'))
    // A failed read keeps the last good capture on screen rather than blanking it.
    expect(JSON.stringify(snapshot())).toContain('89.4')
    const entry = [...context.loader.entries()].find(row => row.options.name === '@deepseek-ai/dsh-quota-antigravity')
    await entry?.fiber?.dispose()
    expect(snapshot()).toBeUndefined()
  } finally { await context.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('serves a refresh requested while the boot read is still in flight', async () => {
  const root = await mkdtemp(join(tmpdir(), 'antigravity-refresh-'))
  let releaseBootRead: (() => void) | undefined
  const bootRead = new Promise<typeof rows>((resolve) => { releaseBootRead = () => resolve(rows) })
  vi.mocked(readQuota).mockReset()
  vi.mocked(readQuota).mockReturnValueOnce(bootRead).mockResolvedValue(rows)
  const context = await boot(root)
  try {
    // The boot read is deliberately still open here, which is the state the
    // panel is in when a user clicks refresh straight after the sidebar loads.
    await vi.waitFor(() => expect(readQuota).toHaveBeenCalledTimes(1))
    await context.settings.update(quota.ANTIGRAVITY_QUOTA_NAMESPACE, { refreshRequestedAt: 1 })
    releaseBootRead?.()
    // Reads stay serial, so the second one can only start after the first ends;
    // what is being asserted is that the request survived the wait instead of
    // being dropped by the in-flight guard.
    await vi.waitFor(() => expect(readQuota).toHaveBeenCalledTimes(2))
  } finally { await context.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})
