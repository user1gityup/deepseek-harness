// Stands in for agy-headless.mjs when every pool seat is out of quota.
process.stdin.resume()
process.stdin.on('end', () => {
  process.stderr.write('agy-headless: seat seat1 failed (quota); handing off\n')
  process.stderr.write('agy-headless: no pool seat could answer. seat1 (quota): RESOURCE_EXHAUSTED | fam1: quota check failed: fetch failed\n')
  process.exit(1)
})
