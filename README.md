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
  template is recorded only when enabled, only when it changes, and only for the
  request Anthropic accepted.

Load this extension after any extension that rewrites Anthropic requests in
`before_provider_request`. Such rewrites loaded later are not captured in the
summary request's system/tools template.

Requires Pi `>=1.5.0 <1.6.0` and Node.js 22.19 or newer. Releases are
validated against Pi 1.5.0. The extension refuses to load on a Pi older than
1.5.0, because Pi does not enforce the package's peer range when it installs
packages.

## Install

```sh
pi install git:github.com/aliceisjustplaying/pi-anthropic-compat
```

Native compaction starts **off**. Open `/anthropic-settings`, enable it, and
press **Ctrl+S** to save and apply.
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

When thinking is enabled and Pi's split keeps recent messages, signed thinking in
kept messages is not bound to its original prefix; Anthropic drops it by default
and no `prefix_mismatch_behavior` is requested.

### Strict tool limits

Anthropic rejects a request whose strict tools exceed its limits, such as more
than 20 strict tools. Pi then retries the turn once with `strict: "prefer"` tools
non-strict. The extension records the system instructions and tools of the
request Anthropic accepted, once its response arrives, so a retried turn leaves
one record and the summary request sends the same non-strict tools.

### Tool changes

When the summarized conversation adds or removes tools, Anthropic records their
net effect in the signed summary. A removal there names a tool that Pi no
longer declares after compaction. The extension records that tool's definition
with the summary and declares it again on every later request, and the summary
then removes it. The model is offered exactly Pi's current tools.

Pi codemode's `only` mode hides direct tools from turn requests, but the
transcript still declares them. Summary requests leave out every current
transcript tool that the last turn request did not send, as its saved request
template records, so they declare the tools the turns sent. The template lists
the request's `tools` and the tools its messages defined inline.

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

- `claude-haiku-5-5`
- `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-sonnet-4-6`
- `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`
- `claude-fable-5-1`, `claude-fable-5`
- `claude-mythos-5-1`, `claude-mythos-5`, `claude-mythos-preview`

The live Models API must also report support. Haiku 4.5 does not support native
on-demand compaction. Unsupported models, other providers, and proxies retain
Pi's ordinary compaction behavior.

**Pi's virtual models are not supported.** Native compaction checks the
selected model, not the model that answers a request. Pi's experimental virtual models, registered with
`pi.registerVirtualModel()`, stay selected while Pi routes each request to a
physical model. With a virtual model selected, `/compact` and automatic
compaction use Pi's ordinary compaction. This holds even when the router sends
every request to a supported Anthropic model. Select that model directly to use
native compaction.

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
concurrent session changes leave the original conversation intact.

The summary request repeats the conversation the turns already cached. Pi marks
a request's last message as a cache breakpoint only when it is a user, system,
or tool-result message, so a summary request that ends with a response would
read only the cached tools and system prompt.
The extension then marks the last cacheable block of the summary request with
Pi's own cache setting, so Anthropic reads the turns' cached prefix. It adds no
breakpoint when Pi sent none or a request already has Anthropic's limit of four.

Anthropic answers a transient compaction failure with HTTP 529
`overloaded_error`, error code `compaction_unavailable`, and documents that the
request should be retried. The extension retries a summary request that fails
with HTTP 529, using Pi's default compaction budget: up to 3 retries after 2,
4, and 8 seconds, or after the server's `retry-after` delay up to 60 seconds.
A warning announces each retry.
The compaction timeout still bounds the whole attempt, and aborting compaction
cancels a pending retry. No other failure is retried. Failure messages name the
HTTP status, Anthropic's error type, and its error code, never the provider's
error text.

Pi reports a cancelled compaction only as "Compaction cancelled". The extension
shows its reason as an error notification and publishes it on the shared
`pi.events` channel `compaction:cancelled` as `{ source: "pi-anthropic-compat",
reason }`. The reason is a complete sentence without provider error text. An
extension that requested the compaction, such as
[`pi-compact-assistant`](https://github.com/2h2d-co/pi-compact-assistant), can
pass it on to the model.

Compaction is billed separately. Accounting uses `usage.iterations`, not the
top-level usage fields, which can be zero on a successful summary request.
Failed summary requests can still incur charges.

The extension stores system/tools templates (while enabled) and signed summaries
in Pi's existing session file. It never stores authentication headers or logs raw
provider error bodies. Treat session files as private conversation data.

## Prompt order

Pi writes the system message that declares the prompt and the initial tools
when the first agent run starts. A `!` shell command run before the first
prompt is already in the session, so it comes first. Pi's Anthropic provider
then finds no leading prompt. It sends the prompt as a mid-conversation system
message and the complete current tool list in `tools` on every request. A tool
added or removed later, for example by an extension such as
pi-compact-assistant, changes `tools`. That request misses the whole prompt
cache, and Anthropic drops the signed thinking of earlier responses.

While native compaction is on, the extension moves that system message ahead of
the shell output in the `context_with_system` event. Pi then sends the prompt in
`system`, keeps `tools` fixed, and defines later tools inline. The session
records the move with a `pi-anthropic-compat-prompt-first` entry, and the order
then holds for the rest of the branch, even after native compaction is turned
off. Summary requests take their system instructions and tools from the saved
template and carry no system message, so they need no reordering.

Sessions that already received a response in the original order keep it until
their next compaction, because moving the prompt would invalidate that
response's thinking. Compaction leads the context with the prompt again.

## Settings

`/anthropic-settings` provides a searchable settings list:

- **Enter** changes the selected value or opens its editor. It never implicitly saves.
- **Space** activates a result or inserts a space when search has focus.
- **Tab / Shift+Tab** move between search, results, and action controls.
- **F1** opens scrollable details, full errors, and the exact save target.
- Edits remain drafts until explicitly applied or saved.
- **Apply to session** applies drafts without writing configuration files and stays open.
- **Ctrl+S** saves and applies changes without closing.
- **Save and close** saves and applies changes, then closes on success.
- **Escape** cancels a field editor or discards unapplied drafts and closes the main menu.
  It does not undo settings already applied to the session.

Search matches labels, configuration keys, and descriptions. Numeric editors
offer presets and custom values across the complete supported range.
**Use inherited value** removes the selected override rather than copying its
current default into the file. Rows show their configuration source.
Pi's remapped selection and cancel keys are respected.

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

`summaryInstructions` is a file-only setting. The menu does not show or change
it. Its text replaces the extension's default summary guidance, which asks
for a concise continuation summary. Its accepted values are a nonempty string of
at most 16,000 characters, or `null` for the default. Every summary request
adds the rule against tool calls after it, and `/compact <instructions>` adds
its guidance last. Ask only to select or emphasize conversation content.
Anthropic's native compaction has refused an instruction to state a fact absent
from the conversation, and a refusal cancels the compaction. A change takes
effect when a session starts or reloads.

```json
{
  "summaryInstructions": "Summarize this conversation for the assistant that will continue the work. Keep each ongoing task's wording and priority exactly as the conversation last stated them."
}
```

A trusted project's `.pi/pi-anthropic-compat.json` overrides global values.
The menu saves to that file when it already exists. Otherwise it saves globally.
Untrusted project configuration is ignored. Invalid configuration produces an
error instead of silently enabling native compaction.

Saving changes only edited overrides and preserves unknown keys and inherited
values. The save target stays fixed while the menu is open. Non-conflicting
external edits are preserved; conflicting edits are rejected for review.
Opening or closing without changes does not create a configuration file.
Reopening shows active session values, not freshly read file values. `*` marks
an unapplied draft. `~` marks an active session override or a value that differs
from the saved configuration. Details shows the saved value when it differs.
Ctrl+S also persists changes previously applied only to the session.
Session settings are stored as extension state entries in the Pi session,
outside model context. They survive menu closure, tree navigation, extension
reload, process restart, and switching away and back. Resuming the same session
restores its settings before provider operations. A new session, fork, or clone
has a separate identity and starts from configuration files.
Pi's `--no-session` mode cannot be resumed after exit. Pi also defers creating a
new session file until its first assistant message.

Applying and saving wait for Pi to become idle. Escape cancels a pending operation
without discarding the draft. Failures leave the menu open. If a save reaches disk
but cannot be applied to the session, the menu reports that distinction and
Ctrl+S retries application. Cooperating writers use a `.settings-lock` file.
An interrupted writer can leave a lock that requires review; locks are not
automatically deleted. External editors do not participate in that lock.
Session overrides retain their original conflict checks across menu reopenings.
Conflicting external edits remain protected after reload or restart.

The menu requires TUI mode. File configuration also works in print and RPC
modes. `/compact <instructions>` supplies additional summary guidance after
`summaryInstructions`.

## Development

```sh
mise trust
mise install
mise run init
mise run check
pi -e .
```

Tests use synthetic responses and real Pi session machinery without network
inference, including a pi-black-style provider wrapper that signs request bodies.
Upstream's billed live tests and release tooling are not maintained in this fork.

## References

- [Anthropic native compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)
- [Anthropic model capabilities](https://platform.claude.com/docs/en/api/beta/models/list)
- [Anthropic preserved-thinking contract](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking#keep-tail-compaction)
