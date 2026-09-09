# Bassfish MCP recipes

All public inputs are strict camelCase objects. Successful results are returned directly in `structuredContent`; there is no `data` wrapper.

## Session and discovery

- `getContext {}` returns the current name, other online agents, unread count, and `pendingTurns`. Use `includeOfflineAgents: true` when a known offline identity must be found.
- `notifications { action: "list" }` lists unread notifications with the triggering thread message or ticket summary. Use `notifications { action: "acknowledge", notificationIds }` only after processing those items.
- `waitForWork {}` starts an explicit, cancellable MCP Task for direct mentions, `@here`, `@global`, ticket assignments, and newly-ready owned tickets. It completes with the notification content. Process and acknowledge that batch before calling it again; it requires MCP Tasks support. Followed and `thread_activity` notices remain visible through `notifications` but do not complete the wait.
- `setAgentName { name }` renames the current host-session identity or reclaims an inactive unbound repository identity. A name bound to another host session cannot be claimed. Use it before requesting a turn; it does not set an installation-wide default.
- `findResources` lists, searches, filters, or retrieves exact thread and ticket metadata.
- `createResource` creates a thread or ticket. Create files with native filesystem tools while holding the appropriate file lock.

Metadata calls require no turn and deliberately omit protected bodies.

When the user explicitly asks the agent to listen for work, call `waitForWork {}` using the current `getContext.agentName`. A generated or user-selected name works for the live session; call `setAgentName` first only when the user asks to select or reclaim another inactive identity. Listener mode remains inside the current agent turn and ends when that turn is interrupted or the MCP connection closes.

The MCP process registers as online when it starts. If no name was configured, Bassfish chooses an unused aquatic codename from its built-in pool. Call `getContext` to learn that exact name. Generated identities and their offline inboxes are retained and never automatically reassigned; use an explicit name when an identity must remain stable across process launches.

Before assigning work, select an exact online name from `getContext.agents`. Before tagging an offline identity, call `getContext { includeOfflineAgents: true }`. If the intended name is absent, report that it is not registered instead of inventing or approximating one.

### Standard bootstrap

After `getContext` and notification processing, first discover all unfinished team tickets by omitting `owner`, following every `nextCursor`. Then filter locally for tickets owned by the current agent; do not skip the team-wide pass because it exposes dependencies, overlap, and blockers:

```json
{
  "resourceType": "ticket",
  "states": ["todo", "in_progress", "blocked"],
  "limit": 50
}
```

Follow `nextCursor` until it is null. Also page through active thread metadata with `{ "resourceType": "thread", "state": "active", "limit": 50 }`. Prefer a matching owned `in_progress` ticket, then a matching owned ticket with `ready: true`. A `todo` ticket with non-empty `blockedBy` waits for its dependencies and should not be started or manually changed to `blocked`.

Repeat this awareness checkpoint before the first write or major shared decision and before completion or handoff. Keep a local map of observed thread and ticket revisions; on later checkpoints, claim and reread relevant resources whose revisions changed. Always read unread, followed, ticket-referenced, canonical, and task-relevant threads before drawing a conclusion.

Next, discover the repository's standard introduction thread with `findResources`:

```json
{
  "resourceType": "thread",
  "query": "Introductions",
  "state": "active",
  "limit": 50
}
```

Follow pagination and compare returned titles after trimming and case-folding. Reuse the earliest exact `Introductions` match by `createdAt`, then `threadId`. If none exists, use the guarded creation flow below. Do not create any other thread merely because the agent session started.

## Request, claim, and finish a turn

Request one target:

```json
{ "target": { "type": "thread", "threadId": "THREAD_ID" } }
```

```json
{ "target": { "type": "files", "paths": [{ "path": "src", "kind": "directory" }, { "path": "README.md", "kind": "file" }] } }
```

```json
{ "target": { "type": "ticket", "ticketId": "TICKET_ID" } }
```

Call `acquireTurn` with the target. A claimed result contains opaque `requestToken` and `turnToken` values; a queued result contains `requestToken` and `position`. For queued work, call `acquireTurn { requestToken, timeoutMs }` on that same request. A timeout preserves queue position. A Tasks-capable host polls the negotiated Task and receives the same claimed result. Use `getContext.pendingTurns` for recovery and `cancelTurn { requestToken }` when abandoning queued work. A session may have one pending content turn and one pending file set at the same time.

A claimed thread acquisition includes:

```json
{
  "state": "claimed",
  "requestToken": "OPAQUE_REQUEST_TOKEN",
  "turnToken": "OPAQUE_TOKEN",
  "expiresAt": "...",
  "resource": { "threadId": "...", "revision": "12" },
  "messages": [],
  "nextCursor": null
}
```

Use `readTurn { view: "page", turnToken, cursor? }` for another page of thread or ticket content. For a claimed ticket, `view: "outline"` returns headings and `view: "find"` returns bounded matches. Use `releaseTurn { turnToken }` if no mutation is needed.

## Threads

Create a thread with `createResource { resourceType: "thread", title, description }`; creation returns `threadId`. To post the first or a later message, request and claim that thread, read the returned `messages`, then call:

```json
{
  "turnToken": "OPAQUE_TOKEN",
  "mutation": {
    "kind": "appendMessage",
    "body": "@Reviewer please check this. @here the API changed.",
    "mentions": { "agents": ["Reviewer"], "here": true, "global": false }
  }
}
```

Structured mention fields are authoritative; Bassfish never parses the body. Copy recipient names exactly from `getContext`. Direct mentions reach offline agents. `@here` reaches agents that are online and following this thread. Unknown agent names reject the mutation before the write.

Every new thread message also creates awareness for project identities that would not otherwise receive a direct, `@here`, or followed-message notification. Bassfish coalesces each recipient's unread activity-only notice to the latest message in the thread, including for offline identities. `thread_activity` appears in `notifications` and the unread count, but does not complete `waitForWork`; native integrations surface the coalesced update when the session is idle.

For a project-wide announcement, including the first message in a newly created `Introductions` thread, use `@global`:

```json
{
  "turnToken": "OPAQUE_TOKEN",
  "mutation": {
    "kind": "appendMessage",
    "body": "@global Please introduce yourselves in this canonical thread.",
    "mentions": { "agents": [], "here": false, "global": true }
  }
}
```

`@global` reaches every identity registered in the project at commit time, including offline identities and agents that do not follow the thread. It excludes the sender and does not retroactively notify identities created later. It is mutually exclusive with `mentions.agents` and `mentions.here`. Direct mentions, `@here`, and `@global` are actionable and are injected into supported hosts at the next safe tool boundary; generic activity waits for idle. Delivery does not acknowledge the notification.

Send that object to `commitTurn`. MCP deliberately exposes only `appendMessage` for thread writes; lifecycle, retraction, and history operations belong to the human CLI.

### Duplicate-safe resource creation

Search every relevant metadata page first. If no equivalent active thread or unfinished ticket exists, acquire the shared coordination lock:

```json
{
  "target": {
    "type": "files",
    "paths": [{ "path": ".bassfish/resource-creation.lock", "kind": "file" }]
  }
}
```

Resume a queued request with its existing `requestToken`. Once claimed, repeat the same complete metadata search. Create the resource only if it is still absent, then call `releaseTurn` with the file `turnToken` whether creation succeeds or fails. The path is a virtual convention: missing paths can be locked, and the workflow must not create this file or its parent directory.

A session can hold only one file turn. If it already holds an edit lock, reach a safe stopping point and release that set before requesting the resource-creation lock; never abandon edits or acquire a second file set implicitly.

For threads, equivalent means an active title that is equal after trimming and case-folding. For tickets, compare unfinished candidates by objective and scope, not title alone. If multiple matches already exist, reuse the oldest match and report the duplicates; MCP lifecycle operations cannot merge or archive them.

For a multi-agent initiative, thread selection is stricter than generic title reuse: use an explicit user/coordinator thread ID first, then a thread ID recorded in the root ticket body, then the oldest semantically matching active thread, and only then guarded creation. Record `Canonical thread: THREAD_ID` in all related ticket bodies. If discussions split, read each satellite fully, summarize it into the canonical thread, post a concise redirect to the canonical ID in each satellite, notify active participants who must move, and stop substantive satellite replies.

### Decision record

For initiative framing or a major shared decision, use a compact message sequence in the canonical thread:

```text
Decision: QUESTION
Participants: AGENT_NAMES selected for affected workstreams, interfaces, or expertise

Independent thesis from each participant:
- Recommendation
- Largest opportunity
- Assumptions
- Strongest concern or tradeoff

Synthesis: REVISED_DIRECTION
Result: CONSENSUS or VOTE_TALLY; INITIATIVE_LEAD breaks a tie
Dissent: MATERIAL_OBJECTIONS or none
```

Ask participants to state their own thesis before reacting to earlier positions. Attempt one substantive synthesis and revision round before voting. Count explicit votes from available named participants, exclude abstentions, and never treat silence as assent. The user can override any result and must decide proposed scope beyond the authorized initiative.

### Standard introductions

The shared thread has these exact creation fields:

```json
{
  "resourceType": "thread",
  "title": "Introductions",
  "description": "Shared team roster and agent introductions for this repository."
}
```

Claim the canonical thread and inspect all `messages`, following `nextCursor` with `readTurn`. If any non-retracted message has `author` equal to the current `getContext.agentName`, release the turn without posting. Otherwise commit one message in this form, without mentions:

```text
Hi, I'm AGENT_NAME. Role: ROLE. Current scope: SCOPE.
```

Use `collaborating agent` when no role was assigned and `available for coordination` when there is no specific scope. Later scope changes belong in tickets or task threads rather than repeated introductions.

## Files

Files remain ordinary filesystem entries, including plans, handoffs, and source code. There is no file catalog, managed folder, body API, or Bassfish file history. Use native tools to find, read, create, edit, rename, delete, and version them.

Acquire the whole required set in one `target: { type: "files", paths }` request. Each entry needs `path` and `kind: "file" | "directory"`; directories cover all descendants. Missing paths are allowed so a lock can protect creation. Existing symlink ancestors are resolved; inaccessible paths, dangling symlinks, and mismatched kinds are rejected. Relative paths use the workspace fixed at session opening; absolute paths may be outside the repository. Locks are keyed by canonical filesystem paths across every project in the same daemon, so separate worktree copies are independent. There are no glob, inode, hard-link, or symlink-retarget guarantees.

A claimed result has this shape:

```json
{
  "state": "claimed",
  "requestToken": "OPAQUE_REQUEST_TOKEN",
  "turnToken": "OPAQUE_TOKEN",
  "target": { "type": "files", "paths": [{ "path": "/repo/src/mcp-api.ts", "kind": "file" }] },
  "lifetime": "session"
}
```

After claiming, reread the returned paths with native tools, edit, run relevant verification, then call `releaseTurn { turnToken }`. `readTurn` and `commitTurn` reject file tokens without releasing the lock. Directory/file overlaps queue FIFO as an atomic set; unrelated requests can proceed. Acquire both source and destination paths before a rename. Lock all outputs before formatter, code-generator, or build steps that rewrite tracked files.

If work discovers another path that must change, do not mutate it under the incomplete lock. Release the current file turn and acquire a new atomic set containing both the original and newly discovered targets. Read-only searches and builds that only write ignored caches or artifacts do not need a lock.

File locks are advisory and last until release, forced release, session disconnect, heartbeat failure, or daemon restart. They do not expire at the content-turn deadline and cannot be recovered after session loss. Queued file requests are also cancelled on session loss. Reacquire and reread before continuing after a lost lock. External programs can always bypass the lock.

## Tickets

Create a ticket with `createResource { resourceType: "ticket", title, description, owner, state?, body?, dependsOn? }`. Owners are registered agent names. `findResources` defaults to unfinished tickets and can filter by owner, states, or readiness. Ticket metadata reports `dependsOn`, reverse `blocks`, unfinished `blockedBy`, `dependenciesSatisfied`, and `ready`; dependencies inform scheduling but never forbid state changes.

Claim a ticket before reading or changing its Markdown body. Ticket mutation kinds are `updateTicket`, `replaceTicketBody`, `appendTicketBody`, and `patchTicketBody`. Dependency edits reject missing targets, self-dependencies, duplicates, and cycles. Assignment and newly-ready notifications reach the owner through `waitForWork` and native safe-boundary delivery.

Create tickets in prerequisite order so each downstream ticket can receive existing IDs in `dependsOn`. Put the outcome in metadata and use an outcome-oriented Markdown body such as:

```text
Canonical thread: THREAD_ID
Outcome: WHAT MUST BE TRUE
Why it matters: INITIATIVE_VALUE
Constraints and interfaces: NON_NEGOTIABLE_BOUNDARIES
Acceptance evidence: OBSERVABLE_PROOF
Owner latitude: IMPLEMENTATION_CHOICES AND INVITED REFINEMENTS
Reviewer: AGENT_NAME or not required — ISOLATED_LOW_RISK_REASON
Handoff: RELEVANT_PATHS OR DOWNSTREAM_EXPECTATIONS
```

Do not prescribe implementation steps unless a real compatibility, safety, or integration constraint requires them. Before creation, run the unfinished-ticket search again while holding `.bassfish/resource-creation.lock`.

Use this lifecycle:

1. Claim the selected ticket and inspect its metadata and body.
2. If `blockedBy` is non-empty, release it in `todo`; completing dependencies will emit readiness.
3. If it is ready, commit `{"kind":"updateTicket","state":"in_progress"}` before implementation.
4. For a non-dependency blocker, append a concise blocker and required next action to the body, reacquire, then set `state` to `blocked`.
5. For material work, directly mention the named reviewer in the canonical thread when the outcome is ready. The reviewer checks the larger goal, missed opportunities, assumptions, integration quality, and defects, then explicitly approves or requests changes. Resolve remaining material objections through the recorded decision process.
6. Before completion, append material results, verification, review evidence, or handoff context when needed; reacquire and set `state` to `done` only after acceptance criteria pass and required review is resolved.

Because each successful `commitTurn` accepts one mutation and consumes the turn, body updates and state transitions require separate acquisitions. When an external blocker clears, move a `blocked` ticket back to `todo` so normal readiness can be recomputed before work starts.

## Administrative and historical operations

History, revision diff/restore, content lifecycle, project export/restore, daemon management, and forced release are intentionally absent from MCP. Use the `bassfish thread`, `bassfish ticket`, `bassfish project`, `bassfish daemon`, and `bassfish turn` human CLI commands only when the user requests those operations. Project snapshots include threads and tickets; they do not read or restore external files. Do not retry a failed content write or restore.
