# pi-anthropic-compat (pi-black-compatible fork)

Native Anthropic compaction for Pi, forked from
[2h2d-co/pi-anthropic-compat](https://github.com/2h2d-co/pi-anthropic-compat).

This fork differs from upstream:

- **It never replaces the `anthropic` provider.** Upstream registers its own
  `streamSimple`, which silently displaces provider wrappers such as
  [pi-black](https://github.com/aliceisjustplaying/pi-black) (or is displaced by
  them). This fork replays signed summaries in `before_provider_request` and sends
  summary requests through `ctx.modelRegistry.streamSimple`, so the registered
  provider (for example pi-black's Claude Code billing block, headers and `cch`
  signature) applies to both.
- **Keep-tail is emulated with Pi's own split.** Only the messages Pi would
  discard (sized by Pi's `compaction.keepRecentTokens`) are summarized. Pi keeps
  the rest verbatim after the signed block. Signed thinking in kept messages is
  not bound to its original prefix, so Anthropic may drop it. No per-turn
  request-boundary entries are written.
- **Nothing is recorded while native compaction is off.** The system/tools
  template is recorded only when enabled, and only when it changes.

Load this extension after any extension that rewrites Anthropic requests in
`before_provider_request`. Such rewrites loaded later are not captured in the
summary request's system/tools template.

Requires **Pi 0.87.0 or newer** and Node.js 22.19 or newer. Releases are
validated against Pi 0.87.1. Opus 5.5 requires Pi 0.87.1's model catalog.

## Install

```sh
pi install git:github.com/aliceisjustplaying/pi-anthropic-compat
```

Native compaction starts **off**. Open `/anthropic-settings` and enable it.
Use your existing Anthropic API key or Claude subscription login in Pi.
The extension does not manage a separate credential store.

## Compaction

With native compaction enabled, `/compact` and Pi's automatic compaction request
a signed summary from Anthropic using `compact-2026-09-04`.

The extension:

- uses Pi's Anthropic serializer and authentication;
- checks the selected model's live compaction capability before summarizing;
- preserves the complete signed block, including opaque fields;
- summarizes the older part of the conversation and keeps Pi's recent messages;
- sends the signed block first on later Anthropic requests;
- preserves original messages in Pi's append-only session tree;
- persists the checkpoint for resume, reload, and branch navigation;
- includes summary generation in Pi's token and cost totals; and
- cancels native compaction on failure without silently switching algorithms.

Run at least one ordinary Anthropic turn before the first native compaction.
This captures the final system instructions and tool definitions after other
extensions have transformed them. The capture persists in the session, so a
resumed session does not need another turn.


### Pi lifecycle

Pi still owns automatic-compaction timing, cancellation, and retry behavior.
Pi also decides whether a session is large enough to compact before invoking
extensions. Very short sessions can return “Nothing to compact.”
The extension does not change Pi's global compaction settings or intercept
`/tree` branch summarization.

Turning native compaction off prevents new native summaries. Existing signed
summaries still replay until another Pi compaction replaces them.

### Models and endpoints

This version supports the direct Claude API and these documented model IDs:

- `claude-sonnet-5`, `claude-sonnet-4-6`
- `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`
- `claude-fable-5-1`, `claude-fable-5`
- `claude-mythos-5-1`, `claude-mythos-5`, `claude-mythos-preview`

The live Models API must also report support. Haiku 4.5 does not support native
on-demand compaction. Unsupported models, other providers, and proxies retain
Pi's ordinary compaction behavior.

When switching to an unsupported model or provider, Pi's readable summary
remains available as ordinary context. Returning to a supported Anthropic
model restores native replay if that checkpoint is still on the active branch.

Bedrock, Google Cloud, threshold compaction, context editing, and background
compaction are not implemented.

### Failure and cost

The summary input must fit the model's context window. Compact before the
window is exhausted. An already oversized conversation may require selecting
an earlier branch rather than attempting native overflow recovery.

Pending tool calls must have results before compaction. Empty or unsigned
summaries, refusals, timeouts, aborted requests, unsupported responses, and
concurrent session changes leave the original conversation intact. The
extension does not retry billed summary requests automatically.

Compaction is billed separately. Accounting uses `usage.iterations`, not the
top-level usage fields, which can be zero on a successful summary request.
Failed summary requests can still incur charges.

The extension stores system/tools templates (while enabled) and signed summaries
in Pi's existing session file. It never stores authentication headers or logs raw
provider error bodies. Treat session files as private conversation data.

## Settings

`/anthropic-settings` provides a searchable settings list:

- **Space** changes a value.
- Changes apply to the current session immediately.
- **Ctrl+S** saves without closing.
- **Enter** saves and closes.
- **Escape** discards changes since opening or the last successful save.

Settings are stored in `~/.pi/agent/pi-anthropic-compat.json`.
`PI_CODING_AGENT_DIR` changes that directory.

```json
{
  "enabled": false,
  "maxSummaryTokens": 4096,
  "timeoutSeconds": 120
}
```

| Setting            | Accepted values            |
| ------------------ | -------------------------- |
| `enabled`          | `true` or `false`          |
| `maxSummaryTokens` | Integer from 1024 to 32768 |
| `timeoutSeconds`   | Integer from 10 to 600     |

A trusted project's `.pi/pi-anthropic-compat.json` overrides global values.
The menu saves to that file when it already exists. Otherwise it saves globally.
Untrusted project configuration is ignored. Invalid configuration produces an
error instead of silently enabling native compaction.

Saving preserves unknown configuration keys and detects file changes made
since the menu opened. Reopen the menu after a concurrent configuration edit.

The menu requires TUI mode. File configuration also works in print and RPC
modes. `/compact <instructions>` supplies additional summary guidance.

## Development

```sh
npm ci --ignore-scripts
npx tsc --noEmit -p .
npm test
pi -e .
```

Tests use synthetic responses and real Pi session machinery without network
inference, including a pi-black-style provider wrapper that signs request bodies.
Upstream's billed live tests and release tooling are not maintained in this fork.

## References

- [Anthropic native compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)
- [Anthropic model capabilities](https://platform.claude.com/docs/en/api/beta/models/list)
- [Anthropic preserved-thinking contract](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking#keep-tail-compaction)
