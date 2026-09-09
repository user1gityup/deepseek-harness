# Agent Note: Antigravity seats with shared permissions

Status: implemented

## Problem

The council needs free workers and distributed research. Antigravity exposes an asynchronous IDE client rather than an answer-producing CLI.

## Decision

Three disabled Gemini-tier seats use an installed driver with stdin prompts and trajectory decoding. Free native-search seats rotate queries, falling back to host search on failure.

The user grants Antigravity the same task-scoped rights and shared memory as Claude Code and Codex. The shared policy names the standing rules, memory index and log, permits native tools for authorized work, and preserves approvals, staging and git ownership.

## Alternatives considered

**Web-only default.** The user superseded this restriction. Optional restricted audits remain available but cannot undo tool effects.

**Independent server.** Claude's measured prototype failed authentication; the driver attaches to the signed-in IDE.

## Consequences

All tiers share one Gemini pool. Native permissions belong to the IDE; the driver does not reproduce Codex sandbox enforcement. Prompts retain the underlying argv limit. Tests cover stdin, audit detection, routing and fallback. Live verification is blocked by Windows process-query access denial in this Codex sandbox.
