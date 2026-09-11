// Stands in for agy-headless.mjs: echoes what it was asked, the way the real
// driver's `--json` mode prints one result line after any stderr chatter.
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  const arg = (flag) => process.argv[process.argv.indexOf(flag) + 1]
  process.stderr.write('agy-headless: answered by seat seat1 in 10ms\n')
  process.stdout.write('not json\n')
  process.stdout.write(`${JSON.stringify({
    text: `model=${arg('--model')} seat=${arg('--seat')} tools=${arg('--tools')} json=${String(process.argv.includes('--json'))} prompt=${input}`,
    seat: 'seat1',
  })}\n`)
})
