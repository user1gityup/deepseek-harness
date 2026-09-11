import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { failureKind, inflightBySeat, rankSeats, readParked, scoreSeat, serviceErrorIn } from '../bin/agy-headless.mjs'
import { ideVersion } from '../bin/agy-profile.mjs'

const OUTDATED =
  'Your current version of Antigravity is out of date. Please visit https://antigravity.google/download to download and install the latest version.'

test('serviceErrorIn treats a rejection written as the answer as a seat failure', () => {
  assert.deepEqual(serviceErrorIn(OUTDATED), { kind: 'outdated', text: OUTDATED })
  assert.equal(serviceErrorIn('RESOURCE_EXHAUSTED: weekly limit')?.kind, 'quota')
  assert.equal(serviceErrorIn('You have reached your weekly quota.')?.kind, 'quota')
  assert.equal(serviceErrorIn('PONG'), undefined)
  assert.equal(serviceErrorIn(''), undefined)
})

test('serviceErrorIn leaves a long answer that discusses quotas alone', () => {
  const answer = `The router parks a seat whose quota is exhausted until its reset time. ${'Detail. '.repeat(60)}`
  assert.equal(serviceErrorIn(answer), undefined)
})

test('failureKind classifies RPC errors and ignores unrelated ones', () => {
  assert.equal(failureKind('rpc error: code = Unauthenticated desc = UNAUTHENTICATED'), 'signed-out')
  assert.equal(failureKind('You are not logged into Antigravity'), 'signed-out')
  assert.equal(failureKind('429 Too Many Requests'), 'quota')
  assert.equal(failureKind('error reading server preface: EOF'), undefined)
})

test('scoreSeat weights the tier, and a drained or zero-weight seat scores nothing', () => {
  assert.equal(scoreSeat({ weight: 4, remainingFraction: 0.5, inflight: 0 }), 2)
  assert.equal(scoreSeat({ weight: 1, remainingFraction: 1, inflight: 1 }), 0.5)
  assert.equal(scoreSeat({ weight: 1, remainingFraction: 0, inflight: 0 }), 0)
  assert.equal(scoreSeat({ weight: 0, remainingFraction: 1, inflight: 0 }), 0)
})

test('rankSeats spreads parallel runs across accounts and drops skipped seats', () => {
  const rows = [
    { seat: { id: 'seat1' }, weight: 1, remainingFraction: 1 },
    { seat: { id: 'fam1' }, weight: 1, remainingFraction: 0.95 },
    { seat: { id: 'gone1' }, weight: 1, remainingFraction: 0 },
    { seat: { id: 'cold' }, skip: 'never signed in' },
  ]
  assert.deepEqual(rankSeats(rows).map((row) => row.seat.id), ['seat1', 'fam1'])
  assert.deepEqual(rankSeats(rows, new Map([['seat1', 1]])).map((row) => row.seat.id), ['fam1', 'seat1'])
})

test('readParked keeps only seats still inside their parking window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-parked-'))
  const path = join(dir, 'parked.json')
  const now = Date.parse('2026-09-11T00:00:00Z')
  writeFileSync(
    path,
    JSON.stringify({ gone1: { until: '2026-09-15T23:23:14Z', reason: 'quota' }, fam1: { until: '2026-09-10T00:00:00Z', reason: 'stalled' } }),
  )
  assert.deepEqual(Object.keys(readParked(path, now)), ['gone1'])
  assert.deepEqual(readParked(join(dir, 'missing.json'), now), {})
})

test('inflightBySeat counts live leases and sweeps leases of dead processes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-leases-'))
  writeFileSync(join(dir, `seat1.${process.pid}.lease`), '{}')
  writeFileSync(join(dir, 'fam1.2147483646.lease'), '{}')
  writeFileSync(join(dir, 'unrelated.txt'), '')
  assert.deepEqual([...inflightBySeat(dir)], [['seat1', 1]])
  assert.deepEqual(readdirSync(dir).sort(), [`seat1.${process.pid}.lease`, 'unrelated.txt'])
})

test('ideVersion reads the version from the package.json inside app.asar', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-asar-'))
  mkdirSync(join(root, 'bin'))
  const pkg = Buffer.from(JSON.stringify({ name: 'antigravity', version: '2.12.2' }))
  const json = Buffer.from(JSON.stringify({ files: { 'package.json': { size: pkg.length, offset: '0' } } }))
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4)])
  const head = Buffer.alloc(16)
  head.writeUInt32LE(4, 0)
  head.writeUInt32LE(8 + padded.length, 4)
  head.writeUInt32LE(4 + padded.length, 8)
  head.writeUInt32LE(json.length, 12)
  writeFileSync(join(root, 'app.asar'), Buffer.concat([head, padded, pkg]))
  const saved = process.env['ANTIGRAVITY_IDE_VERSION']
  delete process.env['ANTIGRAVITY_IDE_VERSION']
  try {
    assert.equal(ideVersion(join(root, 'bin', 'language_server.exe')), '2.12.2')
    assert.equal(ideVersion(join(tmpdir(), 'no-such-install', 'bin', 'language_server.exe')), undefined)
  } finally {
    if (saved !== undefined) process.env['ANTIGRAVITY_IDE_VERSION'] = saved
  }
})
