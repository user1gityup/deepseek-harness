# @deepseek-ai/dsh-quota-antigravity

Reads remaining quota from the running Antigravity language server through its loopback quota-summary endpoint. Discovery obtains ephemeral ports and the per-run CSRF token. Only normalized model-group buckets reach the antigravity-quota settings namespace; the token is never stored.

## Configuration

enabled defaults to true; endpoint defaults to empty for discovery and accepts loopback HTTP(S) URLs only. timeoutMs defaults to 20000; refreshIntervalMs defaults to 300000, with zero disabling polling after boot. refreshRequestedAt requests a serialized refresh. bucketsJson, capturedAt and refreshState contain published state. Failures retain the last capture. Unload aborts discovery and requests.

## Model Experience

None, as this reader publishes quota into settings and registers no model-facing tool or prompt.

#### KV Cache effect

Independent: quota refreshes start no model turn and change no request prefix.

## Known Limitations and Deferred Work

Antigravity must be running and signed in for the DSH user. The private language-server protocol may change. Windows discovery is supported; POSIX discovery requires ps and lsof. Readings can become stale between polls.
