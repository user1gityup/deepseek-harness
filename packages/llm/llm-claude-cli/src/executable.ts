/**
 * Finding a `claude` binary that Node is willing to start.
 *
 * npm puts `claude`, `claude.cmd`, and `claude.ps1` on PATH but leaves the real
 * executable inside the package. Node's fix for CVE-2024-27980 refuses to spawn
 * a `.cmd` or `.bat` with `shell: false` and throws EINVAL, and running one
 * through a shell would re-parse the prompt as a command line — so the real
 * `.exe` is both the safe candidate and the only one that reliably starts.
 * @module @deepseek-ai/dsh-llm-claude-cli/executable
 */

import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Windows spellings to try, most preferred first; the bare name ends the list. */
const WINDOWS_EXTENSIONS = ['.exe', '.com', '.cmd', '.bat', ''] as const

/** Where the real binary lives inside the npm package, relative to a global root. */
const NPM_BIN_PATHS: Readonly<Record<string, readonly string[]>> = {
  claude: [
    '@anthropic-ai/claude-code/bin/claude.exe',
    '@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe',
  ],
}

/**
 * Directories npm uses for global packages on this platform.
 * @returns candidate global `node_modules` roots, most specific first.
 */
function npmRoots(): readonly string[] {
  const roots: string[] = []
  const appData = process.env['APPDATA']
  if (typeof appData === 'string' && appData !== '') roots.push(join(appData, 'npm', 'node_modules'))
  const prefix = process.env['npm_config_prefix']
  if (typeof prefix === 'string' && prefix !== '') roots.push(join(prefix, 'node_modules'))
  roots.push(join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules'))
  return roots
}

/**
 * Resolve a bare CLI name to a real executable when one can be found.
 * @param command - the configured command name.
 * @returns an absolute path to a real executable, or undefined.
 */
export function resolveRealExecutable(command: string): string | undefined {
  if (process.platform !== 'win32') return undefined
  if (command.includes('/') || command.includes('\\')) return undefined
  const relatives = NPM_BIN_PATHS[command.replace(/\.(cmd|exe|bat|ps1)$/i, '')]
  if (relatives === undefined) return undefined
  for (const root of npmRoots()) {
    for (const relative of relatives) {
      const candidate = join(root, ...relative.split('/'))
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // Not installed at this root; try the next.
      }
    }
  }
  return undefined
}

/**
 * Candidate spellings for an executable, most preferred first.
 * @param command - the bare executable name or an explicit path.
 * @returns ordered candidates for this platform.
 */
export function executableCandidates(command: string): readonly string[] {
  if (process.platform !== 'win32') return [command]
  if (/\.(cmd|exe|bat|ps1|com)$/i.test(command)) return [command]
  const real = resolveRealExecutable(command)
  const spellings = WINDOWS_EXTENSIONS.map(ext => command + ext)
  return real === undefined ? spellings : [real, ...spellings]
}

/**
 * Whether a spawn failure means "this spelling does not exist" rather than a
 * real error. ENOENT is the missing file; EINVAL is Node refusing a batch shim.
 * @param message - the spawn error text.
 * @returns true when the next candidate deserves a turn.
 */
export function isWrongSpelling(message: string): boolean {
  return /ENOENT|EINVAL|not recognized|cannot find/i.test(message)
}
