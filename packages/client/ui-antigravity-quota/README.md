# @deepseek-ai/dsh-client-ui-antigravity-quota

Shows Antigravity quota in sidebar.region.action at order -2, above Codex and Claude quota. The collapsed action shows the combined Gemini bucket — the one headless seats spend — across every distinct account. The expanded panel shows each combined bucket with its soonest reset and a countdown, then one row per account: its label, tier, runs in flight, parking, and its own buckets with refill countdowns, or why it could not be read (not running, signed out, unreadable). An account signed in twice is marked as counted once. Zero is displayed as zero. Failed refreshes retain the last capture with a stale-data message.

## Model Experience

None, as the panel only projects the antigravity-quota settings namespace and registers no model-facing content.

#### KV Cache effect

Independent: rendering and refreshing quota change no model request or cached prefix.

## Known Limitations and Deferred Work

- **Host reader required** — the panel shows only what the quota-antigravity plugin publishes.
- **Countdowns are computed at render** — they advance when the panel re-renders, not on a timer.
- **No new allowance after a reset until refreshed** — the panel cannot infer a reading it was not given.
