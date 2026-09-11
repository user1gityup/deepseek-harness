# @deepseek-ai/dsh-quota-antigravity

Reads remaining Antigravity quota for every account on this machine and publishes one combined figure. An account is either a seat in the `agy-profile.mjs` pool — a standalone language server signed in to its own Google account, listed in `~/.dsh/antigravity/accounts.json` with its ports and CSRF token in `<geminiDir>/antigravity/daemon/ls_*.json` — or the running Antigravity IDE's own server, found by process discovery. Each is asked for `RetrieveUserQuotaSummary` and `GetUserStatus` over loopback; neither starts a model turn.

The combined bucket is the tier-weighted share of the pool's allowance still unspent: each distinct account contributes its remaining percentage times its tier weight (`free-tier` and `g1-plus-tier` 1, `g1-pro-tier` 4, `g1-ultra-tier` 16, or the registry entry's own `weight`). Two servers signed in to one Google account count once. The reset shown is the soonest, when the pool next gets quota back.

The reader is read-only: it never starts, stops or signs in a seat, never opens a seat's OAuth token file, and never sweeps the router's leases or parked seats. Account emails are used in memory to de-duplicate and are never published; the CSRF token is never stored.

## Configuration

enabled defaults to true. endpoint defaults to empty for IDE discovery and accepts loopback HTTP(S) URLs only. poolRoot defaults to empty, which uses `DSH_ANTIGRAVITY_ROOT` or `~/.dsh/antigravity`. includeIde defaults to true. timeoutMs defaults to 20000; refreshIntervalMs defaults to 300000, with zero disabling polling after boot. refreshRequestedAt requests a serialized refresh. bucketsJson holds the combined buckets, seatsJson one row per account (id, label, state, tier, weight, counted, in-flight runs, parked-until, buckets), and capturedAt and refreshState the rest of the published state. A read with no counted account publishes the account rows and keeps the last combined capture. Unload aborts discovery and requests.

## Model Experience

None, as this reader publishes quota into settings and registers no model-facing tool or prompt.

#### KV Cache effect

Independent: quota refreshes start no model turn and change no request prefix.

## Known Limitations and Deferred Work

- **Private protocol** — the language-server methods are undocumented and may change with an Antigravity update.
- **Placeholder weights** — the Pro and Ultra tier weights are unmeasured until a seat on either tier is seen.
- **IDE discovery** — Windows discovery is supported; POSIX discovery requires `ps` and `lsof`. Pool seats need no discovery.
- **Stale between polls** — readings change only on refresh, every five minutes by default.
