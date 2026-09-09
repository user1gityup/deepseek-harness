import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { Config } from '../src/index.ts'
import { parseQuotaSummary, parseWindowsServers, parsePosixProcesses, parseLsofPorts, parseEndpoint, readEndpoint, readQuota, QUOTA_PATH } from '../src/reading.ts'

describe('Antigravity quota', () => {
  it('resolves flat defaults without credentials', () => {
    expect(Config({})).toMatchObject({ enabled: true, endpoint: '', timeoutMs: 20000, refreshIntervalMs: 300000, bucketsJson: '[]' })
    expect(Object.keys(Config({})).join(' ')).not.toMatch(/token/i)
  })
  it('normalizes zero, fractions and groups without inventing missing readings', () => {
    const rows = parseQuotaSummary({ response: { groups: [{ displayName: 'Gemini Models', buckets: [
      { bucketId: 'weekly', remainingFraction: 0.8938016, resetTime: '2026-09-15T23:23:14Z' },
      { bucketId: 'empty', remainingFraction: 0 }, { remainingFraction: 2 }, { remainingFraction: -1 },
      { remainingFraction: '1' }, { remainingFraction: null }, { remainingFraction: NaN },
    ] }] } })
    expect(rows.map(row => row.remaining)).toEqual([89.4, 0, 100, 0])
    expect(rows[0]).toMatchObject({ group: 'Gemini Models', id: 'weekly', resetsAt: 1789514594 })
    expect(parseQuotaSummary({ response: { groups: [] } })).toEqual([])
    expect(() => parseQuotaSummary(null)).toThrow()
  })
  it('discovers only Antigravity processes and valid ports', () => {
    const cmd = 'antigravity/language_server.exe --csrf_token abcdefgh-123'
    expect(parseWindowsServers(JSON.stringify({ pid: 42, cmd, ports: [12345, 0, 65536, 1.5] }))).toEqual([{ pid: 42, token: 'abcdefgh-123', ports: [12345] }])
    expect(parseWindowsServers('{')).toEqual([])
    expect(parseWindowsServers(JSON.stringify({ pid: 42, cmd: 'other/language_server.exe --csrf_token abcdefgh-123', ports: [12345] }))).toEqual([])
    expect(parsePosixProcesses(' 42 ' + cmd)).toEqual([{ pid: 42, token: 'abcdefgh-123' }])
    expect(parseLsofPorts('TCP 127.0.0.1:12345 (LISTEN)\nTCP [::1]:12345 (LISTEN)')).toEqual([12345])
  })
  it('rejects remote overrides before discovery and preserves IPv6', async () => {
    for (const url of ['https://example.com:1234', 'file:///tmp/x', 'http://localhost:12/path', 'http://user:secret@localhost:12']) expect(parseEndpoint(url)).toBeUndefined()
    expect(parseEndpoint('http://[::1]:1234')).toEqual({ host: '::1', port: 1234, secure: false })
    await expect(readQuota('https://example.com', 1000, new AbortController().signal)).rejects.toThrow('loopback')
    await expect(readEndpoint({ host:'example.com',port:80,secure:false }, 'secret', 1000, new AbortController().signal)).rejects.toThrow('loopback')
  })
  it('calls the quota method and bounds a response that keeps sending bytes', async () => {
    const server = createServer((req, res) => {
      expect(req.url).toBe(QUOTA_PATH)
      expect(req.headers['x-codeium-csrf-token']).toBe('test-token')
      if (req.headers['connect-protocol-version'] !== '1') throw Error('missing protocol')
      res.writeHead(200)
      if (slow) { const timer = setInterval(() => res.write(' '), 5); res.on('close', () => clearInterval(timer)) }
      else res.end(JSON.stringify({ groups:[{ displayName:'Gemini', buckets:[{ bucketId:'weekly',remainingFraction:1 }] }] }))
    })
    let slow = false
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('missing address')
    const endpoint = { host:'127.0.0.1',port:address.port,secure:false }
    try {
      expect(await readEndpoint(endpoint,'test-token',1000,new AbortController().signal)).toMatchObject([{ remaining:100 }])
      slow = true
      await expect(readEndpoint(endpoint,'test-token',50,new AbortController().signal)).rejects.toThrow('timed out')
      const controller = new AbortController(); controller.abort()
      await expect(readEndpoint(endpoint,'test-token',1000,controller.signal)).rejects.toThrow('cancelled')
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })
})
