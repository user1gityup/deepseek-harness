# Agent Note: Swarm execution profiles

Status: implemented

## Problem

Cost routing alone provided no competing artifacts or paid acceptance of free work.

## Decision

Economy contests each unit with free seats, reuses voting, and requires paid review. One paid fallback candidate and two paid reviews bound escalation. Fastest assigns one paid worker per unit across independent waves. UI units prefer selected eligible sample authors. Approval preserves mode; presets authorize nothing.

Candidates use the existing sandbox under distinct run/unit/seat roots. Graphs require acceptance conditions in economy and reject shared target files. Failed units block dependants. Estimates cover the planned call envelope, not a hard monetary cap.

## Alternatives considered

Cost-weighted votes weaken plans. Unreviewed output cannot establish useful savings. Unlimited fallback misleads approval. Shared roots risk overwrites.

## Consequences

Economy requires two free contestants and paid review capacity. Review is model judgment, not test execution. Files stay staged. No profile retains previous behavior. Plan merging preserves the winner and is separate from code selection.

## Verification

Tests cover competition, paid acceptance, bounded failure, dependency blocking, staging isolation and fastest routing. A Loader composition exercises the real swarm tool with mocked external replies and a snapshot without paid requests.

## Addendum: fastest-profile specialisation (2026-09-08)

`Worker.kinds` existed but every seat carried the same default set, so fit
never discriminated between paid seats in fastest mode. `assignWorkers`
(roster.ts) now takes an optional `EarnedPreference`: `ignoreCost` drops cost
class out of the ranking (fastest's roster is already paid-only, so ranking
by cost class just reintroduces a subscription preference this profile exists
to avoid), and `specialists` maps a work kind to a provider that earned first
refusal on it this run. `swarm.ts` sets `specialists: Map([['code',
options.winner]])` whenever a plan-vote winner is known, so the seat whose
approach won the vote gets the code units, not a hardcoded opinion about
which model writes better code. UI-tier `picked` routing needed no change: it
already runs through the `named`/`task.provider` override ahead of
`assignWorkers`.

Verified against real seats, not only mocks: a throwaway cordis harness
(autoApprove, no mocked askSeat) ran the bare `swarm` tool for an economy
round (free-claude + openrouter-free contesting, deepseek reviewing) and a
fastest round (kimi/deepseek splitting two units across one wave), both
completing and passing paid review. The winner-earned specialist path itself
is proven at the roster and swarm-mock level; live end-to-end coverage needs
a real `pipeline` run, since the bare `swarm` tool carries no `winner`
argument. Detail in `~/.claude/shared-brain/dsh-swarm-profiles.md`.
