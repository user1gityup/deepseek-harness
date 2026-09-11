# @deepseek-ai/dsh-llm-antigravity

An LLM adapter whose transport is Google Antigravity's agent instead of an HTTP
endpoint. It registers the provider route `antigravity` with three models —
`flash_lite`, `flash` and `pro`, the Gemini tiers `agentapi` resolves — and
answers a request by running the installed driver with the prompt on stdin:

```
node ~/.dsh/bin/agy-headless.mjs --model <tier> --tools shared --seat auto \
     --timeout 420000 --title DSH --json
```

That is the same driver the council's `agy-flash-lite`, `agy-flash` and
`agy-pro` seats run, so a pick here spends the same pool of signed-in Google
accounts (`agy-profile.mjs`) and inherits its routing: seats leased by tier
weight and remaining quota, hand-off with the prompt replayed when a seat fails,
drained seats parked until their reset, and the IDE as the last fallback.

Mounting the route makes Antigravity selectable wherever the harness offers a
model: the `/model` popup and composer selector, `agent-default-model`, and a
subagent's `agentOptions`. Nothing routes to it until one of those selects it.

## Cost

Free: Antigravity's Gemini allowance is weekly and per account, and the quota
panel (`quota-antigravity`) shows it combined across the pool. Main-agent turns
carry the conversation on every message, so they drain it faster than an
occasional council seat.

## Settings

The `llm-antigravity` settings section, all optional and read per request:

| Field | Default | Meaning |
|---|---|---|
| `driver` | `~/.dsh/bin/agy-headless.mjs` | The driver `scripts/install-agy-headless.mjs` installs. |
| `seat` | `auto` | `auto`, `pool`, `ide`, or one seat id. |
| `tools` | `shared` | Driver tool policy: `shared`, `web`, `read`, or `any`. |
| `timeoutMs` | `420000` | Cap on one turn. |
| `defaultContextWindow` | `32000` | Context capacity reported to the harness. |
| `maxPromptChars` | `28000` | Most prompt characters per call, at most 28800. |

`shared` is the council seats' policy: native tools under the shared user rules,
enforced by Antigravity's own approval UI rather than by this adapter.

## Model Experience

### Antigravity request

#### What the model sees

The selected Gemini tier receives one prompt: the driver's tool-policy preamble, then the harness system prompt labelled `System:` and cut to at most half of `maxPromptChars`, then a marker naming any older turns left out, then the newest labelled `User:` and `Assistant:` turns that fit. Tool calls and tool results in history are rendered as bracketed text. Harness tool schemas, stop sequences, temperature and output caps are not sent.

#### Token effect

Input is bounded by `maxPromptChars` plus the driver's preamble of about 1,100 characters, so a long session costs no more per call than a short one, at the price of the omitted turns. Antigravity reports no token usage, so none is surfaced.

#### KV Cache effect

Every call starts a new Antigravity conversation, so this adapter gets no prefix reuse between turns; fitting also shifts which turns lead the prompt as a session grows. Changing the model tier or seat changes nothing further.

### Antigravity response

#### What the model sees

The finished answer text becomes one text block for the loop to log and assemble. Tools Antigravity's agent ran inside its own process do not appear in the session.

#### Token effect

Answer length is set by Antigravity; only the retained text block enters later prompts, where it is fitted like any other turn.

#### KV Cache effect

A retained answer appends to the next prompt, which is sent to a fresh conversation, so there is no cached prefix to preserve or invalidate.

## Known Limitations and Deferred Work

- **No harness tools** — Antigravity's agent runs its own tools inside its own process and cannot accept the harness tool set; tool schemas are dropped and reported once per process.
- **No streaming** — the driver returns one finished answer, emitted as a single text block.
- **A bounded prompt** — `agentapi` takes the prompt as one argv entry and Windows caps a command line at 32767 characters, so older turns are dropped to fit and the reported context window is deliberately small.
- **No temperature, output cap, stop sequences or usage** — the driver exposes none of them.
- **Only the Gemini tiers** — Antigravity's Claude and GPT allowance (`3p-weekly`) is not reachable through `agentapi`.
