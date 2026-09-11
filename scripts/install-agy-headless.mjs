#!/usr/bin/env node
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const target = process.argv[2] ?? join(homedir(), '.dsh', 'bin')
mkdirSync(target, { recursive: true })
copyFileSync(new URL('../packages/council/tool-council/bin/agy-headless.mjs', import.meta.url), join(target, 'agy-headless.mjs'))
// agy-headless.mjs imports the seat pool from its sibling, so both are installed together.
copyFileSync(new URL('../packages/council/tool-council/bin/agy-profile.mjs', import.meta.url), join(target, 'agy-profile.mjs'))
writeFileSync(join(target, 'agy.cmd'), '@echo off\r\nnode "%~dp0agy-headless.mjs" %*\r\n')
process.stdout.write(`Installed Antigravity driver in ${target}\n`)
