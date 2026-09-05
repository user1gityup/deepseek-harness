# @deepseek-ai/dsh-llm-claude-cli

An LLM adapter whose transport is a child process instead of an HTTP endpoint.
It registers the provider route `claude-cli`, and answers a request by running
the installed Claude Code binary in print mode:

```
claude --print --output-format stream-json --include-partial-messages --verbose \
       --model <model> --tools "" --strict-mcp-config --safe-mode \
       [--system-prompt <system>] <prompt>
```

The point of the route is credentials: the call is authenticated by whatever
that binary is already signed in as, so there is no API key in this path and
deliberately nowhere to put one.

## What it does not do

Print mode is a smaller surface than a provider API, and the gaps are dropped
rather than approximated:

- **No tools.** The CLI runs its own tool loop internally and cannot be handed
  the harness tool set through this seam. Tool schemas on a request are dropped
  and reported once per process; this provider answers with text only.
- **No temperature, output cap, or stop sequences.** Print mode exposes none of
  them.
- **No context window from the provider.** `defaultContextWindow` is the
  harness's own figure for compaction decisions, not something the CLI stated.

Streaming, reasoning blocks, and token usage all work: the adapter reads the
CLI's `stream-json` events and maps them onto the harness chunk vocabulary.

## Cost

Calls draw on the subscription the binary is logged in as, at that account's
ordinary rate limits. Main-agent turns carry the whole conversation on every
message, so routing the default model here spends considerably more of a weekly
allowance than an occasional council seat does.

## Settings

The `llm-claude-cli` section of `$DSH_HOME/settings.yaml` layers over the
composition entry and is re-read per request:

```yaml
llm-claude-cli:
  command: claude          # executable name or absolute path
  timeoutMs: 600000        # hard cap on one call
  defaultContextWindow: 200000
  safeMode: true           # disable the CLI's own CLAUDE.md, skills, hooks, MCP
  tools: ''                # comma-separated built-in tools; empty disables all
```

Leaving `safeMode` on matters: without it every call loads the user's own
`CLAUDE.md`, skills, hooks, and MCP servers into a request the harness already
built a system prompt for, which both changes the answer and bills the extra
context. Anything enabled in `tools` runs inside the CLI and never reaches the
harness session, so it spends tokens the user cannot see.

To make it the default model:

```yaml
agent-default-model:
  provider: claude-cli
  model: opus              # or sonnet, haiku, or an exact model id
```
