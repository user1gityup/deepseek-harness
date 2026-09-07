# Agent Note: Codex quota above Claude

Status: implemented

## Problem

The DSH sidebar shows Claude allowance but gives no account quota reading for the Codex council seat.

## Decision

A host plugin reads Codex app-server account limits and publishes normalized buckets through settings. A browser plugin registers at order -1 above Claude at 0, displays remaining percentages and reset timestamps, and requests refreshes through the same namespace. Reads start no task or model turn, are serialized and bounded, and await child exit on disposal.

## Alternatives considered

**Token logs:** logs measure usage but do not establish the allowance ceiling.

**Desktop-only tool:** the assistant's usage tool is not a callable dependency of a standalone DSH process. The installed app-server protocol serves that process directly.

## Consequences

Authentication remains owned by Codex. A short-lived process runs on boot, refresh, and each configured poll. Network failures preserve the timestamped capture and surface a failure indicator. Both packages require bundle entries, compiled artifacts, and profile resolution links.
