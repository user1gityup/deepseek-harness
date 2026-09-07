# @deepseek-ai/dsh-quota-codex

Reads `account/rateLimits/read` through `codex app-server` using the existing ChatGPT login. It initializes the protocol without starting a task or model turn. The browser receives normalized quota buckets through `codex-quota` settings, with remaining percentage computed as `max(0, min(100, 100 - usedPercent))`. Missing windows remain unknown.

## Configuration

`enabled` defaults to true. `executable` defaults to resolving Codex on PATH, with the Windows npm binary as a fallback. `timeoutMs` defaults to 20000. `refreshIntervalMs` defaults to 300000; zero disables polling after the initial read. The panel can also advance `refreshRequestedAt` to refresh. Changes to deployment configuration take effect when the plugin reloads.

`bucketsJson`, `capturedAt`, and `refreshState` are published state. Reads are serialized, failures retain the last capture, and unload aborts the child and awaits its exit. Subprocess output is bounded to 1 MiB; secrets in environment variables are removed, stderr is discarded, and only normalized quota fields reach settings.

## Known Limitations and Deferred Work

Requires an installed Codex executable and a ChatGPT login available to the DSH process user. API-key-only accounts may not expose subscription quota. Readings are snapshots, so they may lag between polls; the capture timestamp remains visible after a failed refresh. Authentication stays owned by Codex. This plugin neither signs in nor spends reset credits.

## Model Experience

This plugin does not change model-visible messages, tools, token usage, or KV-cache behavior. Quota refreshes run no model turn.
