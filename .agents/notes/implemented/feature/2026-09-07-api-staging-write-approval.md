# Agent Note: API staging with approved workspace writes

Status: implemented

## Problem

Repeated file approvals interrupt API agents. They need to stage code when local CLI agents are unavailable without inheriting those agents' machine permissions.

## Decision

The base composition enables requireWriteConfirmation and confinedOnly. The human permission control arms workspace writes for 15 minutes. A later direct go in the same live session enables writing. Queued messages predating approval, other sessions and delegated agents cannot confirm. Read-only selection or policy disposal revokes grants; restart does not restore them. Full-access escalation is rejected.

stage_work writes existing API code into a fresh .dsh-staging batch without calling another model or CLI. Proposal output uses the same sandbox writer. Local CLI permissions remain unchanged. A local agent can later review, apply and commit the staged files; this route cannot write the external push queue.

## Alternatives considered

An unconditional writable default permits unapproved work. Per-file approval repeats for every edit. Changing local CLI permissions contradicts the user's design. Proposal-only staging requires another seat round even when code is already available.

## Consequences

Confirmed grants last until revoked or the policy instance ends; pending grants expire. Staging reports partial failures and does not apply code to another repository. Windows process confinement is still partial; no stronger isolation is claimed.

## Verification

Tests cover ordering, queued go, session isolation, expiry, reload, delegated approval and full-access refusal. The real permission command is exercised. A Loader composition runs stage_work against the filesystem sandbox, verifies contents, denies outside writes and checks disposal without paid calls.
