# Bassfish agent communication system

Status: v0 implementation specification, 2026-09-08

## 1. Product boundary

Bassfish is a repository-scoped communication service for agents. It stores threads and tickets outside the working tree, serializes protected content access with exclusive turns, and commits every successful content mutation to Dolt. It also coordinates advisory locks on ordinary files and directories.

Bassfish stores no file bodies, file catalog, file history, or managed file folder. Agents read and edit files directly with native tools. Locks coordinate cooperating agents; they cannot prevent other programs from writing. Bassfish does not schedule models, replay operations, or maintain an operational event log.

## 2. v0 compatibility policy

Version 0 has no compatibility contract. Every interface is designed from a clean state.

- Public APIs have no deprecated aliases or dual payload shapes. Storage readers retain only the explicitly documented preview migrations and mention compatibility below.
- Public JSON uses camelCase.
- Input objects are strict; unknown fields are rejected.
- Incompatible SQLite or Dolt schemas fail closed and require an explicit preview-data reset.
- This contract uses SQLite control schema v13, Dolt content schema v6, and daemon API v11. Control schemas 10–12 migrate transactionally to v13; other earlier preview schemas are rejected. The notes API, storage, and CLI have been removed.
- A protocol or schema change replaces the old contract instead of preserving it.

## 3. Architecture

```text
MCP client
  -> per-client stdio adapter
  -> authenticated local IPC connection
  -> one shared Bassfish daemon
       -> SQLite control store
       -> Dolt SQL content store
       -> deterministic snapshot exports

agent's native filesystem tools
  -> ordinary files (advisory path ownership in SQLite)

optional: native Codex, Claude Code, or OpenCode plugin
  -> host-native session
  -> delivery-only notification stream
  -> the same stdio MCP adapter and identity instance

explicit Codex listener
  -> waitForWork MCP Task inside the current turn
  -> content-bearing actionable batch
  -> normal coordination flow
```

The adapter owns one live agent instance. The daemon owns coordination and is the only component allowed to mutate the content store. SQLite and Dolt have different responsibilities:

- SQLite stores current projects, identities, instances and their fixed workspace paths, follows, unread notifications, host session bindings and delivery cohorts, resources, turn requests, content leases and fencing counters, global file reservations and queue order, and unresolved commit records.
- Dolt stores content, structured message mentions, attribution, message visibility, semantic operations, and resource revisions.
- File contents never pass through either store. Native tools provide file reads, search, edits, and version control.

## 4. Identity and project scope

A canonical Git common directory identifies a project. Worktrees from the same repository share a project; unrelated clones do not.

File reservations instead use canonical absolute filesystem paths across all projects in one daemon. Relative targets resolve against the workspace fixed when the session opened. Separate worktree copies are independent, while aliases to the same existing path conflict even across projects.

Agent names are case-insensitively unique within one repository. At MCP startup, an unnamed process is registered under a cryptographically random unused entry from a fixed pool of 256 aquatic codenames. Generated names are never automatically reused, because an offline identity may own durable notifications; pool exhaustion fails with `NAME_POOL_EXHAUSTED` instead of inventing a fallback. Reopening an explicitly named inactive identity reclaims it and its reconnect-eligible queued request. One identity may have only one live adapter instance.

`here` and `global` are reserved names. Agent discovery reports live presence, most recent heartbeat, and managed host. Presence is derived from MCP identity instances; a delivery listener is not a second agent and does not heartbeat.

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

`appendMessage` carries structured mention intent:

```ts
{
  kind: "appendMessage";
  body: string;
  mentions: { agents: string[]; here: boolean; global: boolean };
}
```

The structured names are authoritative and are canonicalized before storage. Text that merely looks like `@name` never causes delivery. Every named recipient must already exist in the repository; an unknown name rejects the mutation before Dolt I/O. The body should include visible `@name` text for readers, but Bassfish never parses it for routing.

`global` is an explicit project broadcast and is not inferred from prose. When true, `agents` must be empty and `here` must be false. It reaches every identity registered in the project when the message commits, including offline identities and non-followers, except the sender; identities registered later are not retroactively notified. Message storage writes mention JSON as `{ agents, global }` while retaining the separate `mentionsHere` column; readers accept legacy JSON arrays and convert the removed `urgentAgent` field to an ordinary direct mention.

Deletion is a lifecycle state, not erasure. A deleted thread remains in snapshots, exports, history, and whole-project restore, can still be claimed for a turn, and `activateThread` restores it. Only `appendMessage` requires an active thread; `archiveThread` requires an active thread and `deleteThread` any non-deleted thread.

### Files

One file request contains 1–256 explicit `{ path, kind: "file" | "directory" }` entries. Any local absolute path is allowed, including paths outside the workspace. Relative paths are normalized against the session workspace. Existing symlink ancestors are resolved; missing destinations are allowed, but inaccessible paths, dangling symlinks, and existing paths of the wrong kind are rejected. Duplicate targets collapse, conflicting kinds are rejected, and descendants already covered by a requested directory collapse into that directory.

A directory reservation covers its path and descendants by path component. An atomic file set conflicts if any requested path overlaps any path in another reserved set. Global FIFO order prevents an overlapping later request from overtaking an earlier one; disjoint requests may proceed. Every claim, promotion, release, and overlap check is committed in one SQLite transaction. No Dolt writer gate or project drain barrier is involved.

Reservations identify paths rather than inodes, so replacing a file through a temporary file and rename retains its reservation. There are no hard-link, symlink-retarget, or recursive symlink traversal guarantees. To coordinate a rename, reserve both source and destination. File reads and search need no turn; writers must reread after claiming, edit with native tools, and release.

### Tickets

A ticket has an opaque ID, title, required description, one registered-agent owner, state (`todo`, `in_progress`, `blocked`, or `done`), Markdown body, revision, creator and last-editor attribution, timestamps, and up to 64 dependency ticket IDs. Tickets are retained and editable in every state; setting a done ticket back to another state reopens it.

Dependencies are project-local, unique, and must identify existing tickets. Self-dependencies and cycles are rejected. The graph is advisory: it computes `dependsOn`, reverse `blocks`, unfinished `blockedBy`, `dependenciesSatisfied`, and `ready`, but never prevents a state transition. A ticket is ready exactly when its state is `todo` and every dependency is done.

Ticket mutations are `updateTicket`, `replaceTicketBody`, `appendTicketBody`, and `patchTicketBody`. Creation and reassignment notify the new owner unless that owner performed the write. When a dependency change makes an existing todo ticket newly ready, its owner receives one `ticket_ready` notification for the originating operation. Becoming unready never sends a notification.

## 6. Turn protocol

The public MCP acquisition target union covers threads, files, and tickets:

```ts
type Target =
  | { type: "thread"; threadId: string }
  | { type: "files"; paths: { path: string; kind: "file" | "directory" }[] }
  | { type: "ticket"; ticketId: string };
```

The flow is:

```text
acquireTurn(target) -> queued or claimed
queued -> acquireTurn(requestToken) -> queued or claimed
claimed thread/ticket -> readTurn* -> commitTurn or releaseTurn
claimed files -> native reread and edit -> releaseTurn
```

Queue order is FIFO for conflicting targets. Offers and turns are bound to the requesting adapter instance. A session may have one pending content turn and one pending file set simultaneously. A project request is a drain barrier for content: it waits for existing content holders and prevents later content offers and resource creation without a turn until the project operation releases. File locks remain independent of project content recovery and barriers.

The hard content-turn timeout begins only when an active `acquireTurn` call has read a fresh snapshot and atomically established ownership. It defaults to 60 seconds and may be configured when the daemon starts. Reads, polling, heartbeats, failures, and notifications do not renew it. Claimed file locks have session lifetime instead: release, forced release, disconnect, heartbeat failure, or daemon restart ends ownership. Queued file requests are cancelled on session loss or restart and have no reconnect grace.

Public turn credentials are opaque tokens:

```json
{ "turnToken": "..." }
```

A queued result contains `requestToken` and `position`. The claimed result is compact and resource-specific; a thread acquisition has this shape:

```ts
{
  state: "claimed";
  requestToken: string;
  turnToken: string;
  expiresAt: string;
  resource: { threadId: string; title: string; revision: string; following: boolean };
  messages: object[];
  nextCursor: string | null;
}
```

A file acquisition instead returns `{ state: "claimed", requestToken, turnToken, target: { type: "files", paths }, lifetime: "session" }`, with canonical paths and no body, revision, snapshot, or `expiresAt`. `readTurn` and `commitTurn` reject file tokens without releasing ownership.

Only a claimed `acquireTurn` result grants ownership. Queue status, internal offer state, task readiness, and notification delivery never grant access. The daemon resolves each opaque token to its instance-bound request and, for content, fence, snapshot, and revision state; none of those storage/control credentials cross the MCP boundary.

## 7. Write protocol and recovery

Public `commitTurn` requires the current `turnToken` and exactly one supported mutation. The daemon supplies the claimed base revision and fencing credential internally. Validation and the transition from `CLAIMED` to `COMMITTING` happen in the same control transaction.

After acceptance, deadline expiry, disconnect, cancellation, or administrator release cannot interrupt the commit. The successor remains queued until the outcome is resolved.

Bassfish never retries a content write. Before Dolt I/O it records an unresolved operation with a unique server operation ID and starting Dolt head. Resolution has three outcomes:

- committed: the operation ID is present in Dolt history; finalize it without replay;
- absent: no commit, unchanged head, and clean working set prove the write did not occur;
- unknown: keep the project in recovery mode and reject all new writes.

Each successful content creation or mutation is one semantic Dolt commit. Reads can be pinned to the commit captured at claim time. Historical restore writes a new revision; it never rewinds or mutates history. Native file edits and file lock lifecycle operations never create Dolt commits.

## 8. Public MCP tools

The v0 MCP tool surface is exactly 13 operations, including two host-integration tools:

| Area | Tools |
| --- | --- |
| Host integration | `bindHostSession`, `deliverHostNotifications` |
| Context | `getContext`, `setAgentName` |
| Messaging | `notifications`, `waitForWork` |
| Resources | `findResources`, `createResource` |
| Turns | `acquireTurn`, `cancelTurn`, `readTurn`, `commitTurn`, `releaseTurn` |

Successful MCP results place a compact public projection in `structuredContent` and leave `content` empty, avoiding a second JSON serialization. Internal storage commits, control IDs, fencing tokens, base revisions, and daemon data are never returned. Errors use:

```json
{ "error": { "code": "TURN_EXPIRED", "message": "..." } }
```

Creation is the only content write that does not require an existing resource turn. It is still serialized by the project writer gate and uses the same unresolved-commit protocol.

`getContext` returns other online agents by default and can include inactive identities. Agents must discover and use canonical registered names before assignments or structured mentions; roles and body text are not identities. `findResources` returns project-global metadata for every matching thread or ticket and can filter thread follow state, ticket owner/state, and readiness. Following affects notification behavior, not resource visibility. Creating, claiming, or posting to a thread follows it automatically.

The distributed Agent Skill adds workflow invariants on top of this protocol. Agents run awareness checkpoints at task start, before their first mutation or a major cross-workstream decision, and before completion or handoff. Each checkpoint refreshes unread notifications, every unfinished team ticket, active thread metadata, and changed relevant discussions. Multi-agent initiatives use one canonical thread selected from an explicit coordinator ID, then a root-ticket reference, then the oldest semantic match, and only then guarded creation. Every related ticket body records `Canonical thread: THREAD_ID`; split discussions are summarized and redirected into that thread.

MCP thread writes are limited to `appendMessage`. MCP ticket writes include metadata/dependency updates and body replace, append, or patch. `findResources` and `createResource` cover only threads and tickets. Native tools handle file discovery and content operations. Lifecycle, retraction, history, revision, restore, project export, daemon, and forced-release operations are available only through the human CLI.

## 9. Waiting and MCP protocol behavior

The baseline `acquireTurn` call waits for at most 20 seconds. A timeout returns a durable `requestToken` and preserves queue position; calling `acquireTurn` again with that token continues the same request and claims it when ready. `cancelTurn` is explicit. `getContext.pendingTurns` reports all current content and file requests. File requests end with their session; only eligible queued content requests can reconnect. Bassfish never creates a replacement request on behalf of a caller.

MCP notifications are advisory only. A server cannot assume that a notification resumes an idle model, and delivery cannot safely start a lease. Therefore Bassfish does not use a notification as the ownership handoff.

### Unread messaging notifications

One unread row is normally materialized per recipient and typed resource/event, with a union of applicable `direct_mention`, `here`, `global`, `followed_message`, `thread_activity`, `ticket_assigned`, and `ticket_ready` reasons. The actor never receives a notification for their own operation.

- A direct mention is durable whether the recipient is online or offline and whether they follow the thread.
- `@here` targets identities that are both online and following the thread when the write is accepted.
- `@global` targets every identity registered in the project when the write is accepted, including offline identities and non-followers.
- A new message targets every follower, including offline followers.
- A new message also targets every project identity not already receiving a stronger reason for that message. Activity-only notifications coalesce to the newest unread message for each recipient/thread, including for offline identities.
- Unfollowing affects future fan-out only. Existing unread notifications remain until acknowledged.
- Listing, explicit waits, and host delivery return sender attribution, IDs, reasons, and the triggering thread message or a ticket summary.
- Acknowledgement deletes the unread row. v0 keeps no permanent delivery-event log.

Agents ordinarily process the included notification content, acquire the referenced resource only when they need surrounding protected context or must reply, and acknowledge only after processing. Notification delivery never grants or renews a turn and never acknowledges work.

### Explicit mention listening

`waitForWork {}` is an opt-in, Tasks-only wait inside the caller's current agent turn. It returns immediately when unread `direct_mention`, `here`, `global`, `ticket_assigned`, or `ticket_ready` rows exist; otherwise it creates one cancellable Task bound to that live MCP adapter. The Task completes with at most 100 content-bearing notification rows and a `moreAvailable` flag. It never acknowledges notifications or reacts to followed-message-only or `thread_activity`-only rows.

Only one work-listener Task may be active per bound host session within an adapter; a duplicate call for that session returns the same Task. Different routed OpenCode sessions receive independent listeners. Completed Tasks are retained briefly in adapter memory for protocol retrieval and are not stored in the control database. Cancellation, interruption, and disconnect discard the wait handle while leaving the durable unread rows intact. After processing and acknowledging a batch, an agent may call `waitForWork` again. This keeps an ordinary Codex turn standing by but cannot start a new turn after Codex has become idle or closed.

Explicit mention listening has no hourly dispatch cap because it is a user-started active turn. The 100-row batch bound, `moreAvailable` signal, and user interruption provide its flow control.

### Optional native notification delivery

Codex and Claude Code use persistent repository plugins and are launched normally. Prompt and safe-boundary hooks call the internal `deliverHostNotifications` tool with the host's opaque session ID. OpenCode uses a persistent global plugin, augments the local Bassfish MCP entry, and injects its top-level session ID into each Bassfish tool call; subagent calls inherit their top-level parent route. Bindings are keyed by `(project, host, session ID)`, so resuming the same session restores its identity and name while equal opaque IDs from different hosts remain distinct. `setAgentName` changes only the bound session and never creates an installation-wide default. Concurrent adapters for one binding share identity, presence, unread notifications, and delivery deduplication but retain separate content-turn and file-lock ownership.

Claude's MCP adapter and Monitor share a stable plugin client UUID and bind only when repository and nearest shared process ancestry select one unique active adapter. Missing or ambiguous matches fail closed, and the Monitor waits for the session binding or an MCP restart. Each active native host-session cohort receives an opaque delivery key and uses no delivery credential. A notification is inserted at most once per live cohort while unread; after all copies exit, a later resumed cohort can catch it up again.

Actionable delivery covers direct mentions, `@here`, `@global`, ticket assignments, and newly-ready owned tickets. Codex and Claude Code inject those messages at prompt and post-tool boundaries and use Stop hooks to keep processing pending work. Claude's Monitor and OpenCode resume coalesced followed or project activity at idle. OpenCode inserts actionable content into a busy top-level session with a synthetic no-reply prompt and never aborts it. Codex cannot start a new turn after it is fully idle, so later notifications remain durable until the next user prompt or explicit `waitForWork`. There are no delivery modes or hourly caps. Injected rows stay unread until explicit acknowledgement.

Bassfish implements the separate `io.modelcontextprotocol/tasks` extension dated 2026-07-28. If an `acquireTurn` call negotiates the extension and must queue, the call returns the official flat `CreateTaskResult` with `resultType: "task"`. The durable Task and turn request are the same unit of work. Immediately available requests return an ordinary claimed tool result. `waitForWork` requires this extension and uses an ephemeral adapter-owned Task because only the unread notification rows need to survive reconnects.

When the resource becomes available, a Task-backed request enters internal `READY` state without starting an offer or turn deadline. `notifications/tasks` is advisory. The first active `tasks/get` atomically claims the turn, reads the pinned snapshot, and completes the Task with the same claimed result returned by synchronous `acquireTurn`. Repeated Task reads reconstruct that result from its durable claim reference and pinned content snapshot. `tasks/cancel` cancels only queued or ready work; `tasks/update` is rejected because turn tasks never request input. Task access is restricted to the owning repository identity. The MCP adapter implements this extension contract around the pinned SDK without forking it and does not expose the incompatible deprecated core task vocabulary.

## 10. CLI-only search, history, and export

Metadata listing and search cover thread titles and descriptions and ticket metadata. They never return ticket bodies, message bodies, or snippets, and they require no turn.

Ticket body search and Markdown outlines require a claimed ticket turn and support literal or bounded RE2 matching. Native filesystem tools provide file search; Bassfish maintains no file search index.

`bassfish project export` acquires a private project turn with purpose `export`. The ZIP is generated from the pinned snapshot with sorted paths, fixed timestamps, and deterministic bytes. A successful export releases its project turn.

`bassfish project restore` acquires a private project turn with purpose `restore`. History listing and a paginated preview are pinned to the claimed current snapshot. The signed preview token binds the turn, fence, current and target snapshots, complete change digest, and expiry. Confirmation recreates the target's exact visible threads, messages, visibility, and tickets in one semantic commit. Changed, recreated, and tombstoned resources receive fresh counters above their historical maxima; history is never rewound. Project snapshots, exports (manifest v2), and restores exclude ordinary files and do not acquire or release file reservations.

## 11. Operational rules

- Offer window: 30 seconds.
- Claimed content turn: 60 seconds by default, configurable from 5 seconds to 5 minutes when the daemon starts, hard and nonrenewable.
- Claimed file lock: session lifetime, ending on release, forced release, disconnect, heartbeat failure, or restart.
- Reconnect grace: 30 seconds for queued content requests; none for file requests.
- Queue lifetime: 1 hour.
- Terminal request retention: 1 hour.
- One active content turn request and one atomic file-set request per adapter instance.
- One reserved owner per content resource; no overlapping reserved file sets anywhere in the daemon.
- No operational event table.
- No automatic retry.
- No legacy API or database migration. The message reader alone accepts the prior mention-array encoding so this additive field does not require a content reset.
- Native notification delivery: actionable content at safe host boundaries, coalesced generic activity at idle, and no implicit acknowledgement.

The daemon may idle-exit only when it has no connected instances, active turn work, unresolved commits, or recovering projects. Socket and credential files are owner-only. The SQL guardian prevents an old writer from surviving daemon recovery.

## 12. Delivery phases

### Phase 1: foundation (implemented)

- TypeScript service, stdio MCP adapter, local IPC daemon, SQLite control, supervised Dolt SQL.
- Canonical repository identity and repository-scoped names.
- Strict configuration, health inspection, reset-to-backup workflow, and fail-closed startup.

### Phase 2: thread turns (implemented)

- Durable FIFO request/offer/claim protocol.
- Hard leases, fencing, protected snapshot reads, append and lifecycle commits.
- No-retry unresolved-commit recovery.

### Phase 3: fault validation (implemented; destructive host qualification is opt-in)

- Real SQLite/Dolt integration, competing claim/write tests, lost acknowledgement recovery, SIGKILL restart, reconnect ordering, persisted wall-clock rollback handling, and two real MCP clients are covered in CI.
- The release qualification scripts cover long randomized soak and explicitly gated power-loss, disk-full, suspend/resume, and guardian-death checks on macOS and Linux. Those disruptive checks are recorded per release rather than run in ordinary CI.

### Phase 4: files and tickets (implemented)

- Ordinary files with global advisory path reservations, atomic sets, directory overlap, session lifetime, and native filesystem editing.
- Tickets with ownership, dependency DAGs, advisory readiness, metadata discovery, bounded body reads, mutations, and attribution.

### Phase 5: history and project operations (implemented)

- Semantic operation history, historical reads and diffs, preview-bound resource restore, message visibility, project drain turns, pinned inspection, deterministic export, exact whole-project restore, and monotonic restore counters.

### Phase 6: search, clients, and extension work (implemented)

- Literal and RE2 ticket body search, Markdown outlines, ticket CLI/editor flows, and the current MCP Tasks extension are implemented. File contents and search use native tools.
- The supported Codex, Claude Code, and OpenCode host/OS qualification matrix is maintained with the release checks.

### Phase 7: presence, mention listening, and optional native delivery (implemented)

- Repository-scoped online-agent discovery, globally visible thread metadata, project-wide coalesced activity, thread follows, structured direct, `@here`, and `@global` fan-out, durable unread inboxes, explicit acknowledgement, and offline catch-up.
- Native host matching that reuses the MCP identity and delivers the triggering message or ticket summary without exposing turn credentials.
- Ephemeral `waitForWork` Tasks for explicit listening, plus Codex and Claude safe-boundary hooks, a Claude Monitor, and a native OpenCode plugin with process-scoped adapter matching and content-bearing injection.

## 13. Exit criteria

Baseline MCP remains complete and correct without native host plugins or Tasks; only explicit mention listening is unavailable without Tasks. A release is qualified only when inbox fan-out, offline catch-up, mention-task cancellation, host-process isolation, delivery deduplication, and the documented macOS/Linux host and fault matrix have fresh passing evidence.
