import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditTools, policyPreamble, toolCallsFrom } from '../bin/agy-headless.mjs'

const field = (id, bytes) => {
  const varint = n => { const out = []; do { const b = n & 127; n >>>= 7; out.push(b | (n ? 128 : 0)) } while (n); return out }
  const data = Buffer.from(bytes)
  return Buffer.from([...varint(id * 8 + 2), ...varint(data.length), ...data])
}
const step = name => ({ step_type: 15, step_payload: field(20, field(7, Buffer.concat([field(2, name), field(3, '{}')]))).join(',') })

test('restricted audit detects file tools; shared policy grants native tool parity', () => {
  const steps = [step('view_file'), step('search_web'), step('write_to_file')]
  assert.deepEqual(toolCallsFrom(steps).map(call => call.name), ['view_file', 'search_web', 'write_to_file'])
  assert.deepEqual(auditTools(steps, 'web').map(call => call.name), ['view_file', 'write_to_file'])
  assert.deepEqual(auditTools(steps, 'read').map(call => call.name), ['write_to_file'])
  assert.deepEqual(auditTools(steps, 'shared'), [])
  assert.match(policyPreamble('shared'), /shared-agent-log.md/)
  assert.match(policyPreamble('shared'), /CLAUDE.md/)
  assert.match(policyPreamble('shared'), /Do not bypass it with native tools/)
})
