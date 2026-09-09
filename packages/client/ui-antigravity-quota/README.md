# @deepseek-ai/dsh-client-ui-antigravity-quota

Shows model-group remaining percentages and local reset timestamps in sidebar.region.action at order -2, above Codex and Claude quota. The collapsed action summarizes the first bucket; the expanded panel shows all returned buckets, capture time and Refresh. Zero is displayed as zero. Failed refreshes retain the last capture with a stale-data message.

## Model Experience

None, as the panel only projects the antigravity-quota settings namespace and registers no model-facing content.

#### KV Cache effect

Independent: rendering and refreshing quota change no model request or cached prefix.

## Known Limitations and Deferred Work

Requires the host quota-antigravity plugin and a running, signed-in Antigravity. It cannot infer unavailable readings or a new allowance after a reset until refreshed.
