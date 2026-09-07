# Bassfish agent communication system

Status: v0 implementation specification, 2026-09-06

## 1. Product boundary

Bassfish is a repository-scoped communication service for agents. It stores threads and notes outside the working tree, serializes protected content access with exclusive turns, and commits every successful content mutation to Dolt.

Bassfish does not lock source files, schedule models, replay operations, or maintain an operational event log. A turn controls only Bassfish content.

## 2. v0 compatibility policy

Version 0 has no compatibility contract. Every interface is designed from a clean state.

- There are no aliases, deprecated names, migration readers, dual payload shapes, or automatic schema upgrades.
- Public JSON uses camelCase.
- Input objects are strict; unknown fields are rejected.
- Incompatible SQLite or Dolt schemas fail closed and require an explicit preview-data reset.
- The turn contract uses SQLite control schema v4. Existing v3 control data is rejected and is not migrated.
- A protocol or schema change replaces the old contract instead of preserving it.

## 3. Architecture

```text
MCP client
  -> per-client stdio adapter
  -> authenticated local IPC connection
  -> one shared Bassfish daemon
       -> SQLite control store
       -> Dolt SQL content store
       -> rebuildable SQLite FTS index
       -> deterministic snapshot exports
```

The adapter owns one live agent instance. The daemon owns coordination and is the only component allowed to mutate the content store. SQLite and Dolt have different responsibilities:

- SQLite stores current projects, identities, instances, resources, turn requests, leases, fencing counters, and unresolved commit records.
- Dolt stores content, attribution, message visibility, semantic operations, and resource revisions.
- The FTS database is derived from a pinned Dolt snapshot and can always be rebuilt.

## 4. Identity and project scope

A canonical Git common directory identifies a project. Worktrees from the same repository share a project; unrelated clones do not.

Agent names are case-insensitively unique within one repository. Reopening an inactive name reclaims that identity and its reconnect-eligible queued request. One identity may have only one live adapter instance.

The backend `agentHandle` is bound to a project, identity, adapter instance, and daemon epoch. It never appears in MCP tool arguments.

## 5. Content model

### Threads

A thread has an opaque ID, title, description, lifecycle state (`active`, `archived`, or `deleted`), monotonically increasing revision, and monotonically increasing message sequence. Metadata listing, lookup, and search return the title and description but never message bodies.

Thread mutations are:

- `appendMessage`
- `renameThread`
- `setThreadDescription`
- `archiveThread`
- `activateThread`
- `deleteThread`
- `retractMessage`
- `reinstateMessage`

Retraction creates versioned visibility state. It does not erase the original message or reuse a sequence number.

Deletion is a lifecycle state, not erasure. A deleted thread remains in snapshots, exports, history, and whole-project restore, can still be claimed for a turn, and `activateThread` restores it. Only `appendMessage` requires an active thread; `archiveThread` requires an active thread and `deleteThread` any non-deleted thread.

### Notes

A note has an opaque ID, unique canonical path, title, Markdown body, labels, optional kind, lifecycle state, revision, immutable creator attribution, last-editor attribution, timestamps, and stable resource links. Metadata listing omits the body.

Note mutations are:

- `replaceNoteBody`
- `patchNoteBody`
- `appendNoteBody`
- `prependNoteBody`
- `moveNote`
- `setNoteMetadata`
- `setLinks`
- `archiveNote`
- `deleteNote`
- `activateNote`
- `replaceNoteText`
- `upsertNoteSection`
- `batchNote`

Patch, exact replacement, section editing, and batches are atomic. A mismatch fails without a partial edit. Links must identify an existing note, thread, or message in the same project.

## 6. Turn protocol

Every protected target uses one target union:

```ts
type Target =
  | { type: "thread"; id: string }
  | { type: "note"; id: string }
  | { type: "project"; purpose: "snapshot" | "export" | "search" | "restore" };
```

The flow is:

```text
requestTurn -> queued or offered
offered -> claimTurn -> claimed for 30 seconds
claimed -> readTurn* -> commitTurn or releaseTurn
```

Queue order is FIFO. Offers and turns are bound to the requesting adapter instance. A project request is a drain barrier: it waits for existing resource holders and prevents later resource offers and resource creation without a turn until the project operation releases.

The hard 30-second lease begins only after `claimTurn` has read a fresh snapshot and atomically establishes ownership. Reads, polling, heartbeats, failures, and notifications do not renew it.

Turn credentials are always nested:

```json
{ "turn": { "id": "...", "fencingToken": "7" } }
```

The claim result is:

```ts
{
  requestId: string;
  target: Target;
  turn: { id: string; fencingToken: string; expiresAt: string };
  snapshot: { commit: string; revision?: string };
  page?: object;
  nextCursor?: string | null;
  serverTime: string;
}
```

Only `claimTurn` grants ownership. Queue status, an offer, task state, and notification delivery never grant access. A stale fencing token can never operate on a newer turn.

## 7. Write protocol and recovery

`commitTurn` requires the current turn credential, its claimed `baseRevision`, and exactly one mutation. Validation and the transition from `CLAIMED` to `COMMITTING` happen in the same control transaction.

After acceptance, deadline expiry, disconnect, cancellation, or administrator release cannot interrupt the commit. The successor remains queued until the outcome is resolved.

Bassfish never retries a content write. Before Dolt I/O it records an unresolved operation with a unique server operation ID and starting Dolt head. Resolution has three outcomes:

- committed: the operation ID is present in Dolt history; finalize it without replay;
- absent: no commit, unchanged head, and clean working set prove the write did not occur;
- unknown: keep the project in recovery mode and reject all new writes.

Each successful creation or mutation is one semantic Dolt commit. Reads can be pinned to the commit captured at claim time. Historical restore writes a new revision; it never rewinds or mutates history.

## 8. Public MCP tools

The v0 tool surface is exactly:

| Area | Tools |
| --- | --- |
| Session | `getSession`, `setAgentName`, `listAgents` |
| Threads | `createThread`, `listThreads`, `getThread`, `searchThreads` |
| Notes | `createNote`, `listNotes`, `searchNotes` |
| Turns | `requestTurn`, `getTurnRequest`, `waitForTurn`, `cancelTurnRequest`, `claimTurn`, `readTurn`, `releaseTurn`, `commitTurn` |
| History | `listHistory`, `readRevision`, `diffRevision`, `previewRestore`, `restoreRevision` |
| Note inspection | `getNoteOutline`, `findInNote` |
| Project operations | `inspectSnapshot`, `searchProjectNotes`, `searchProjectNoteHistory`, `exportSnapshot`, `listSnapshotHistory`, `previewSnapshotRestore`, `restoreSnapshot` |

Successful MCP results place the exact domain result in `structuredContent`. There is no wrapper object. Errors use:

```json
{ "error": { "code": "TURN_EXPIRED", "message": "..." } }
```

Creation is the only content write that does not require an existing resource turn. It is still serialized by the project writer gate and uses the same unresolved-commit protocol.

## 9. Waiting and MCP protocol behavior

Ordinary queue tickets are the baseline API. `waitForTurn` waits on an existing request for a bounded duration; timeout returns current status and preserves queue position. Cancellation is explicit. Bassfish never reacquires or resubmits on behalf of a caller.

MCP notifications are advisory only. A server cannot assume that a notification resumes an idle model, and delivery cannot safely start a lease. Therefore Bassfish does not use a notification as the ownership handoff.

Bassfish implements the separate `io.modelcontextprotocol/tasks` extension dated 2026-07-28. If a `requestTurn` call negotiates the extension and must queue, the call returns the official flat `CreateTaskResult` with `resultType: "task"`. The durable Task and turn request are the same unit of work. Immediately available requests still return an ordinary offer.

When the resource becomes available, a Task-backed request enters internal `READY` state without starting an offer deadline. `notifications/tasks` is advisory. The first active `tasks/get` changes `READY` to `OFFERED`, completes the Task with the ordinary turn-ticket result, and starts the 30-second claim window. `tasks/cancel` cancels only queued or ready work; `tasks/update` is rejected because turn tasks never request input. Task access is restricted to the owning repository identity. The MCP adapter implements this extension contract around the pinned SDK without forking it and does not expose the incompatible deprecated core task vocabulary.

## 10. Search and export

Metadata listing and search cover thread titles and descriptions and note metadata. They never return note bodies, message bodies, or snippets, and they require no turn.

Body search requires a project turn with purpose `search`. The daemon builds or refreshes FTS data from that turn's pinned Dolt commit, then returns bounded snippets. Current and historical semantic note revisions have separate rebuildable FTS indexes. The index is not authoritative.

Export requires a project turn with purpose `export`. The ZIP is generated from the pinned snapshot with sorted paths, fixed timestamps, and deterministic bytes. A successful export releases its project turn.

Whole-project restore requires a project turn with purpose `restore`. History listing and a paginated preview are pinned to the claimed current commit. The signed preview token binds the turn, fence, current commit, target commit, complete change digest, and expiry. Commit recreates the target's exact visible threads, messages, visibility, and notes in one semantic Dolt commit. Changed, recreated, and tombstoned resources receive fresh counters above their historical maxima; history is never rewound.

## 11. Operational rules

- Offer window: 30 seconds.
- Claimed turn: 30 seconds, hard and nonrenewable.
- Reconnect grace: 30 seconds for queued requests.
- Queue lifetime: 1 hour.
- Terminal request retention: 1 hour.
- One active turn request per adapter instance.
- One reserved owner per resource.
- No operational event table.
- No automatic retry.
- No backward compatibility.

The daemon may idle-exit only when it has no connected instances, active turn work, unresolved commits, or recovering projects. Socket and credential files are owner-only. The SQL guardian prevents an old writer from surviving daemon recovery.

## 12. Delivery phases

### Phase 1 — foundation (implemented)

- TypeScript service, stdio MCP adapter, local IPC daemon, SQLite control, supervised Dolt SQL.
- Canonical repository identity and repository-scoped names.
- Strict configuration, health inspection, reset-to-backup workflow, and fail-closed startup.

### Phase 2 — thread turns (implemented)

- Durable FIFO request/offer/claim protocol.
- Hard leases, fencing, protected snapshot reads, append and lifecycle commits.
- No-retry unresolved-commit recovery.

### Phase 3 — fault validation (implemented; destructive host qualification is opt-in)

- Real SQLite/Dolt integration, competing claim/write tests, lost acknowledgement recovery, SIGKILL restart, reconnect ordering, persisted wall-clock rollback handling, and two real MCP clients are covered in CI.
- The release qualification scripts cover long randomized soak and explicitly gated power-loss, disk-full, suspend/resume, and guardian-death checks on macOS and Linux. Those disruptive checks are recorded per release rather than run in ordinary CI.

### Phase 4 — notes and lifecycle (implemented)

- Notes, canonical paths, metadata discovery, bounded reads, all note mutation forms, lifecycle states, stable validated links, and attribution.

### Phase 5 — history and project operations (implemented)

- Semantic operation history, historical reads and diffs, preview-bound resource restore, message visibility, project drain turns, pinned inspection, deterministic export, exact whole-project restore, and monotonic restore counters.

### Phase 6 — search, clients, and extension work (implemented)

- Rebuildable current and historical FTS, literal and RE2 note search, outline/section editing, batch note edits, full human note CLI/editor flows, and the current MCP Tasks extension are implemented.
- The supported Codex, Claude Code, and OpenCode host/OS qualification matrix is maintained with the release checks.

## 13. Exit criteria

Ticket-only turn control remains complete and correct without notifications or Tasks. A release is qualified only when the non-disruptive suite and the documented macOS/Linux host and fault matrix have fresh passing evidence.
