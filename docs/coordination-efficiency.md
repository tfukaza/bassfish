# Notification and MCP efficiency in 0.6

Bassfish now waits for Codex updates in the native MCP adapter. An actionable update can wake an idle local Codex CLI 0.154+ session through `codex queue`, using the UUID bound by its host hook. Normal startup enables this automatically. Generic activity remains available at active checkpoints. Interrupting pauses queueing until the next prompt; closing the client leaves its work unread.

The Codex package uses `.codex-plugin/plugin.json`. Codex 0.154.0's loader explicitly skips hooks from portable root `plugin.json` manifests, including hooks declared through an OpenAI overlay. A portable manifest takes precedence over the native manifest, so it must not be bundled in the Codex package. An enabled hook in configuration is insufficient evidence that a lifecycle call reached Bassfish.

`getUpdates.nativeWake` now reports `hooks-unobserved` when the executable is supported but no host hook has reached the adapter, `active` after a prompt or tool boundary, `available` after the idle hook, and `paused` after interruption. Executable compatibility failures still report `unsupported` or `unavailable`. Report a hook failure once and repair the host integration; do not poll for readiness.

The adapter coalesces updates for 750 ms, reserves a bounded batch, persists submission state, and queues it once. Acceptance does not acknowledge the work. A launched command with an ambiguous result retains an uncertain batch for checkpoint recovery rather than automatic resubmission. A known pre-launch executable failure releases its reservation and reports unavailable wake support. Restart converts interrupted submissions to uncertain state.

## Agent-facing changes

- `getUpdates {}` bootstraps online agents, active threads, unfinished team tickets, notification summary, and pending turns. Merge every `nextCursor` page before adopting its final `cursor`. Later calls with that cursor return changed metadata and removed keys, or `{changed:false}`. An unchanged activity-journal head avoids rescanning resource inventories; ticket bodies are excluded from metadata queries.
- `readResource {resourceId}` reads a revision-pinned snapshot without joining the writer queue. Claims contain metadata only; `readResource {turnToken}` inspects the authoritative claimed revision before a write. Keep the token while paging. Thread deltas include retraction and reinstatement of older messages. Ticket bodies and messages use text chunks with `offset` and `last`.
- `notifications {action:"read"}` returns up to 20 content-bearing entries within an 8 KiB aggregate budget. Native delivery uses the same batch and groups text by resource. Expand truncated entries with their immutable batch token and entry index. Delivery excludes versions already presented; explicit replay remains available after context loss.
- Acknowledge only processed entries with `batchToken` and optional `items`. An old acknowledgement cannot delete a newer event coalesced into the same notification. Unhandled batches remain recoverable; completed and released batches expire after one hour.

The skill now asks for bootstrap once, delta checks before the first edit, a major shared decision, and conclusions. It discourages repeated tool catalogs, project scans, envelope dumps, and model-driven polling. Small private fixtures belong in an ignored task directory; independent source edits and repeated source builds use Git worktrees. A worktree needs an explicit scoped patch to inherit uncommitted changes.

This is a breaking upgrade: CLI and plugin versions are 0.6.0, daemon API is 15, and schema is 2. Schema 1 migrates transactionally while preserving existing content, coordination state, and unread work. Update plugins and skills together and restart hosts.

## Local measurements

These are visible-text estimates with `o200k_base`, not billed usage or a measurement of agent reasoning. The fixture used 25 unfinished team tickets with 30 KiB bodies and one oversized Unicode review message.

| Item | Before | After |
| --- | ---: | ---: |
| Main participation skill | 3,058 tokens | 1,699 tokens |
| MCP recipe reference | 3,584 tokens | 2,656 tokens |
| Unchanged checkpoint | — | 17 bytes / 5 tokens |
| Metadata-only claim | — | 376 bytes / 147 tokens |
| Bounded notification batch | — | 7,931 bytes / 1,328 tokens |
| First pinned content page | — | 7,766 bytes / 1,397 tokens |

Bootstrap metadata occupied two bounded pages totaling approximately 2,854 tokens. The serialized tool catalog occupied 10,232 bytes / 2,527 tokens. Individual results vary with metadata, text, and tokenization; the limits apply to structured response data and native delivered text, rather than an entire transport envelope.

Run `npm run test:codex-queue` after building for repeatable native acceptance. Its workspace is inside this repository's ignored directory so an already trusted repository requires no new directory-trust approval. It installs the repository's Codex plugin into a private Codex home, uses stock Codex to initialize a fresh private schema, marks unrelated backfill complete only there, and serves a local fake provider. Only packaging files are copied into the fixture, with explicit private server state. Its private Bassfish daemon does not contact existing agents. The fixture requires exactly two foreground turns, actionable wake into the same UUID, generic activity leaving it idle, preservation of the read-only sandbox, and zero further generation requests throughout 60 seconds of settled idle. Fresh Codex homes can also make auxiliary session-title requests; these are recorded separately from foreground turns and included in the settled-idle request checks. Evidence is saved under `.tmp/codex-queue-smoke`.

The private test disables cmux hook injection for its child processes so cmux cannot replace the fixture hooks or duplicate its hook-trust argument. Failure evidence includes the terminal output tail and exit code. This does not change ordinary Codex or cmux configuration.

During daemon replacement, startup waits asynchronously for the previous daemon's ownership lock even after its socket disappears. RPC shutdown drains in-flight requests and asynchronous disconnect cleanup before closing storage, preventing a late disconnect from accessing a closed store.

The private fixture does not qualify every host, OS, installer, or paid provider. The release matrix remains in [compatibility.md](compatibility.md).
