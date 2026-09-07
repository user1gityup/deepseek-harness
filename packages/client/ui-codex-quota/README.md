# @deepseek-ai/dsh-client-ui-codex-quota

Shows Codex remaining subscription quota above Claude quota in the sidebar (`sidebar.region.action`, order -1; Claude uses 0). The expanded panel shows every returned bucket, primary and secondary windows, provider-reported window durations, local reset timestamps, the last capture time, and a Refresh button.

The panel reads the host plugin's `codex-quota` settings namespace. Zero remaining is displayed as zero; missing windows display Unavailable. Failed refreshes retain the last reading and show a stale-data message. The collapsed action summarizes the first available window, preferring the Codex bucket. English and Chinese dictionaries follow the app locale.

## Known Limitations and Deferred Work

Requires `@deepseek-ai/dsh-quota-codex` on the host. The browser never reads credentials or launches Codex. It cannot infer unavailable quota or a new allowance after a reset until the host gets a fresh response.

## Model Experience

This plugin does not change model-visible messages, tools, token usage, or KV-cache behavior. Quota refreshes run no model turn.
