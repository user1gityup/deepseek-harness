# Agent Note: The swarm runs council seats, behind its own approval gate

Status: implemented

## Problem

Swarm work was built against subagent providers and left disabled. Three faults kept it unusable.

Workers and seats were separate registries. The swarm roster hardcoded `claude-code`, `codex` and `spawn`; the council's agents were the five seats in `seats.ts`. Configuring an agent for the council did not make it available to the swarm, and the panel offered `codex`, which no mount registers, so a worker that could never run looked available. Adding a model meant editing a bundle manifest, which is not something a user does.

The swarm could only start from a council decision. The chain from `runCouncil` to a decomposition was never wired, and every design for it began at an agreed answer. A user who already knows what they want had no path that did not first buy a debate.

Mounting `agent-team` exposed `spawn_teammate` to the model with no execution approval gate, so the model could create workers unasked.

## Decision

The swarm's workers are the council's seats, and a swarm run is a separate tool with its own two-factor gate. `agent-team`, `tool-agent-team` and the subagent worker providers stay unmounted; nothing in this path calls `spawn_teammate`.

### Workers are seats

`seatRoster(seats, overrides)` in `roster.ts` derives the roster from the configured seats. A worker's routing key is its seat id. A `cli` seat is `included` and a `openrouter` seat is `metered`, so ties break toward a subscription already paid for. Absent an override a seat joins the swarm the way it joined the council; `swarmRoster` overrides then set participation and kinds per seat without changing whether that seat sits on the council.

The client derives the same list. `DEFAULT_SEATS` and `seatsFrom` moved from `CouncilBudget.tsx` into `capacity.ts`, and both the budget panel and `SwarmRoster.tsx` read them. `roster-drift.spec.ts` compares that list against the host's `DEFAULT_SEATS` and now reads `capacity.ts`. A user-added OpenRouter seat appears as a worker with no further configuration, and the panel shows each seat's model id.

### A run starts from the request

`runSwarm` in `swarm.ts` decomposes the request itself. `directDecomposePrompt` states that no approach has been agreed and asks for the work the request actually contains; it shares its reply shape and rules with `decomposePrompt` through one `shape()` helper, so the two prompts cannot drift. The planner is chosen from the seats that will do the work, so a run cannot be planned by a seat the user switched off.

The run stops at four points before it spends: no seat switched on, no seat able to plan, a graph carrying any problem `validateGraph` reports, and a unit no enabled seat can take. Each returns `blocked` with the reasons, having made at most the one planning call.

### The gate

`swarm` is a separate tool holding `pendingSwarmId`, `pendingSwarmQuery`, `pendingSwarmTasks`, `pendingSwarmIssuedAt`, `approvedSwarmId` and `approvedSwarmAt`. These are distinct from the council's slots: a council approval must not authorise a graph of workers, and the two cost differently. `judgeApproval` and `planExpired` are reused unchanged, so both gates require the Approve control plus a later user turn, expire after `PLAN_TTL_MS`, and are single-use.

The approved graph is stored as JSON and run verbatim. An approved run never decomposes again: re-planning would produce a graph the user never read, and reusing the stored one also makes approval free, because the planning call was paid for before the gate. `readStoredTasks` parses that JSON at the durable boundary and treats anything unreadable as absent, which sends the run back to the gate rather than executing a half-parsed graph.

A held, unapproved graph is shown again rather than re-planned. Without that, a model calling back would spend another planning call and reset the gate on every attempt, so the run could never reach execution.

`CouncilCallView` serves both gates. The result marker carries the gate kind (`<!--council-plan:ID-->` or `<!--swarm-plan:ID-->`) and the view selects the matching settings keys from one `GATES` table.

### Execution

`executionWaves` orders the graph; a wave's units run together, or one at a time under `sequential`. Each unit's worker gets the original request as context, its own unit, and the reports of the units it depends on, because a seat has not read the conversation and will otherwise invent what it cannot see. A failed dependency's report is omitted rather than passed on empty.

## Alternatives considered

**Mount one subagent provider per model.** `subagent-dsh-sdk` takes a `provider` and `model`, so a mount per model would give the swarm real per-model workers with sessions that can write. Rejected as the primary path because it puts agent configuration back in the bundle manifest: adding a model would mean editing YAML, and the seats the user already configured would still not be usable. It remains the route to write-capable workers and is not foreclosed by this change.

**Reuse the council's `pendingPlan*` slots for both gates.** Fewer settings fields, and the Approve control would need no gate kind. Rejected because one approval would then stand for either action: a user who approved a council debate would have authorised a graph of workers, and the two differ in both cost and effect.

**Re-decompose on the approved call instead of storing the graph.** Avoids holding a JSON blob in settings. Rejected because the second decomposition is not guaranteed to match the first, so approval would carry work the user never read; storing it also removes the second planning call's cost.

**Have the council hand its decision to the swarm.** The original design, and still reachable through `decomposePrompt`. Rejected as the only entry point because it forces a user who already knows what they want to buy a debate first.

## Consequences

Seat workers are read-only. A seat is a one-shot prompt over its own transport, and the shipped CLI seats run `--allowedTools WebSearch,WebFetch,Read,Glob,Grep`. Units research, read and report; they do not write files or run commands. Widening that is a change to a seat's own argv, made by the user. The `swarm.toggleOn` and `swarm.toggleHint` strings were rewritten to say so, in both locales; they previously described workers that write files and run commands.

Cost estimation prices a metered seat from the OpenRouter table and counts an unpriced one rather than treating it as free. A subscription seat is reported as consuming quota, not as costing nothing.

`gen-tool-catalog` fails for `tool-council` because that package is absent from `TOOL_PACKAGES`; the condition predates this change and is unaffected by it.

## Verification

`packages/council/tool-council/tests/swarm.spec.ts` covers the gate and execution: the run stops with a priced plan and no unit call, each blocking condition reports its own reason, an approved run executes the stored graph without a second planning call, a unit reaches the seat it was assigned, a named seat is honoured, a failed unit is recorded without stopping the rest, and `sequential` orders a wave. `roster.spec.ts` covers `seatRoster` derivation, override precedence, unknown-kind rejection, and assignment across it. 209 tests pass in the package.
