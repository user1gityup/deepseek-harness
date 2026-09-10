import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bucketsFrom, identityFrom, isAlive, parseJsonFile, readDiscovery, seatEnv } from '../bin/agy-profile.mjs'

const withTempDir = fn => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-profile-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const writeDiscovery = (geminiDir, name, body) => {
  const daemon = join(geminiDir, 'antigravity', 'daemon')
  mkdirSync(daemon, { recursive: true })
  writeFileSync(join(daemon, name), body, 'utf8')
}

/**
 * The response body is the one captured live from
 * `RetrieveUserQuotaSummary`, trimmed only of fields the router ignores. The
 * Gemini bucket is weekly, so `resetTime` is days out rather than a
 * retry-after, and both facts have to survive the flattening.
 */
test('bucketsFrom flattens the live quota summary and keeps the weekly reset', () => {
  const body = JSON.stringify({
    response: {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'gemini-weekly',
              window: 'weekly',
              remainingFraction: 0.8938016,
              resetTime: '2026-09-15T23:23:14Z',
            },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1, resetTime: '2026-09-15T23:55:15Z' },
          ],
        },
      ],
    },
  })
  const buckets = bucketsFrom(body)
  assert.equal(buckets.length, 2)
  assert.deepEqual(
    buckets.map(b => b.bucketId),
    ['gemini-weekly', '3p-weekly'],
  )
  assert.equal(buckets[0].group, 'Gemini Models')
  assert.equal(buckets[0].window, 'weekly')
  assert.equal(buckets[0].remainingFraction, 0.8938016)
  assert.equal(buckets[0].resetTime, '2026-09-15T23:23:14Z')
})

test('bucketsFrom accepts an unwrapped body and never throws on junk', () => {
  const unwrapped = JSON.stringify({ groups: [{ displayName: 'G', buckets: [{ bucketId: 'b', remainingFraction: 0.5 }] }] })
  assert.equal(bucketsFrom(unwrapped)[0].bucketId, 'b')
  assert.deepEqual(bucketsFrom('not json at all'), [])
  assert.deepEqual(bucketsFrom('{}'), [])
  assert.deepEqual(bucketsFrom(JSON.stringify({ response: { groups: 'nope' } })), [])
})

/**
 * Regression: `Out-File -Encoding utf8` under PowerShell 5.1 and most Windows
 * editors prepend a UTF-8 BOM. Before this was handled, a hand-edited
 * registry parsed as zero seats and `start` reported "start needs a seat id"
 * for a seat that was plainly listed in the file.
 */
test('parseJsonFile tolerates a UTF-8 BOM', () =>
  withTempDir(dir => {
    const BOM = '﻿'
    const path = join(dir, 'accounts.json')
    writeFileSync(path, `${BOM}${JSON.stringify({ seats: [{ id: 't1' }] })}`, 'utf8')
    assert.equal(parseJsonFile(path).seats[0].id, 't1')

    const plain = join(dir, 'plain.json')
    writeFileSync(plain, JSON.stringify({ ok: true }), 'utf8')
    assert.equal(parseJsonFile(plain).ok, true)
  }))

test('readDiscovery returns pid, ports and token from the newest daemon file', () =>
  withTempDir(dir => {
    writeDiscovery(
      dir,
      'ls_e3b0c44298fc1c14.json',
      JSON.stringify({ pid: 4242, httpsPort: 50849, httpPort: 59400, lspPort: 0, csrfToken: 'tok-1' }),
    )
    const found = readDiscovery(dir)
    assert.equal(found.pid, 4242)
    assert.equal(found.httpPort, 59400)
    assert.equal(found.httpsPort, 50849)
    assert.equal(found.csrfToken, 'tok-1')
  }))

test('readDiscovery rejects an unusable file rather than returning a half-target', () =>
  withTempDir(dir => {
    assert.equal(readDiscovery(dir), undefined, 'no daemon directory')

    writeDiscovery(dir, 'ls_a.json', JSON.stringify({ pid: 1, httpPort: 1234 }))
    assert.equal(readDiscovery(dir), undefined, 'no csrf token')

    writeDiscovery(dir, 'ls_a.json', JSON.stringify({ pid: 0, httpPort: 1234, csrfToken: 'tok' }))
    assert.equal(readDiscovery(dir), undefined, 'no usable pid')

    writeDiscovery(dir, 'ls_a.json', 'truncated{')
    assert.equal(readDiscovery(dir), undefined, 'unparseable')
  }))

/**
 * A discovery file outlives the process that wrote it, so a seat is only
 * reachable when both the file and the pid are good. `lsVersion` and a stale
 * pid are exactly what a crashed seat leaves behind.
 */
/**
 * Regression, captured live: this account carries `planName: "Pro"` and
 * `TEAMS_TIER_PRO` in the inherited Codeium plan block while its real
 * Antigravity tier is `free-tier`. Reading planStatus labelled every free seat
 * "Pro", which would have had the router preferring the emptiest seats.
 */
test('identityFrom reports the Antigravity tier, not the inherited plan block', () => {
  const body = JSON.stringify({
    userStatus: {
      name: 'kevin luster',
      email: 'kevin.luster@katakiinc.com',
      planStatus: { planInfo: { teamsTier: 'TEAMS_TIER_PRO', planName: 'Pro', monthlyPromptCredits: 50000 } },
      userTier: {
        id: 'free-tier',
        name: 'Antigravity Starter Quota',
        upgradeSubscriptionText: 'This account is ineligible for higher rate limits through a Google AI plan at this time.',
      },
    },
  })
  const identity = identityFrom(body)
  assert.equal(identity.email, 'kevin.luster@katakiinc.com')
  assert.equal(identity.tierId, 'free-tier')
  assert.equal(identity.tierName, 'Antigravity Starter Quota')
  assert.match(identity.ineligibleNote, /ineligible for higher rate limits/)
  assert.equal('plan' in identity, false, 'the Codeium plan block must not leak into the identity')
})

test('identityFrom returns undefined rather than a nameless seat', () => {
  assert.equal(identityFrom('not json'), undefined)
  assert.equal(identityFrom('{}'), undefined)
  assert.equal(identityFrom(JSON.stringify({ userStatus: { name: 'no email here' } })), undefined)
  // A seat with no tier block is still usable; the email alone identifies it.
  assert.deepEqual(identityFrom(JSON.stringify({ userStatus: { email: 'a@b.co' } })), {
    email: 'a@b.co',
    name: '',
    tierId: '',
    tierName: '',
    ineligibleNote: '',
  })
})

/**
 * Regression for the bug that made three seats report one Google account: the
 * standalone OAuth token is written to `<home>/.gemini/
 * jetski-standalone-oauth-token`, so only the home variables move it into the
 * seat. APPDATA and LOCALAPPDATA must be left alone — redirecting those stops
 * the language server booting.
 */
test('seatEnv pins the home directory into the seat and leaves the rest alone', () => {
  const env = seatEnv('C:\\seats\\alpha')
  assert.equal(env.USERPROFILE, 'C:\\seats\\alpha')
  assert.equal(env.HOME, 'C:\\seats\\alpha')
  assert.equal(env.HOMEDRIVE, 'C:')
  assert.equal(env.HOMEPATH, '\\seats\\alpha')
  assert.equal(env.APPDATA, process.env.APPDATA, 'APPDATA must be inherited unchanged')
  assert.equal(env.LOCALAPPDATA, process.env.LOCALAPPDATA, 'LOCALAPPDATA must be inherited unchanged')
  assert.equal(env.PATH ?? env.Path, process.env.PATH ?? process.env.Path)
})

test('seatEnv gives two seats different homes', () => {
  const a = seatEnv('C:\\seats\\alpha')
  const b = seatEnv('C:\\seats\\beta')
  assert.notEqual(a.HOME, b.HOME)
  assert.notEqual(a.HOMEPATH, b.HOMEPATH)
})

test('isAlive separates a live pid from a stale one', () => {
  assert.equal(isAlive(process.pid), true)
  assert.equal(isAlive(0), false)
  assert.equal(isAlive(-1), false)
  assert.equal(isAlive(undefined), false)
  assert.equal(isAlive(0x7ffffffe), false)
})
