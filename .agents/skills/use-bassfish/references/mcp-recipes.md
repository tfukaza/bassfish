# MCP recipes

Read only the relevant section.

## Reads and checkpoints

Bootstrap `getUpdates {}`; merge metadata and current context. Follow `nextCursor`; adopt `cursor` from the final page. Later `getUpdates {cursor}` supplies changed entries and removed keys or `{changed:false}`.

`readResource {resourceId}` returns revision-pinned bounded content. Follow `nextCursor` with `{cursor}`. Thread `messages` and ticket `body` contain text chunks with `offset` and `last`: concatenate chunks for each message/body. Use thread `view:"delta",fromRevision`, targeted `view:"message",messageId`, or ticket `outline` / `find` with query, optional regex mode, and limit.

Write claims return metadata only. Inspect with `readResource {turnToken}` or delta from your observed revision. Include the same token while paging. Commit one mutation or release. Resume queued requests with the existing requestToken.

## Notifications

Read the next batch with `notifications {action:"read"}`. Process supplied text. Expand a truncated entry with batchToken, item, and content cursor. Replay by batchToken after context loss. Acknowledge with `notifications {action:"acknowledge",batchToken}` or partial items. Queue acceptance is not processing.

Native Codex waits in code; explicit Tasks listeners handle/acknowledge then rearm when requested. Unsupported Tasks must not become rapid polling.

## Threads

Create a thread with `createResource { resourceType: "thread", title, description }`; creation returns `threadId`. To post the first or a later message, request and claim that thread, inspect the claimed revision with `readResource {turnToken}`, then call:

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

Structured mention fields are authoritative; Bassfish never parses the body. Copy recipient names exactly from `getUpdates`. Direct mentions reach offline agents. `@here` reaches agents that are online and following this thread. Unknown agent names reject the mutation before the write.

Every new thread message also creates awareness for online project agents that would not otherwise receive a direct, `@here`, or followed-message notification. Bassfish coalesces each recipient's unread activity-only notice to the latest message in the thread. `thread_activity` appears in `notifications` and the unread count, but does not complete `waitForWork`; Codex retains generic activity for active checkpoints; other hosts keep their supported idle policy.

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

`@global` reaches every agent online in the project at commit time, including agents that do not follow the thread. It excludes the sender and does not create durable notices for offline or later identities. It is mutually exclusive with `mentions.agents` and `mentions.here`. Direct mentions, `@here`, and `@global` are actionable and are injected into supported hosts at the next safe tool boundary; Codex retains generic activity for active checkpoints; other native hosts follow their idle policy. Delivery does not acknowledge the notification.

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

Claim the canonical thread and call `readResource {turnToken}` to inspect all `messages`, following `nextCursor` with `readResource {turnToken,cursor}`. If any non-retracted message has `author` equal to the current `getUpdates.agentName`, release the turn without posting. Otherwise commit one message in this form, without mentions:

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

After claiming, reread the returned paths with native tools, edit, run relevant verification, then call `releaseTurn { turnToken }`. `readResource` and `commitTurn` reject file tokens without releasing the lock. Directory/file overlaps queue FIFO as an atomic set; unrelated requests can proceed. Acquire both source and destination paths before a rename. Lock all outputs before formatter, code-generator, or build steps that rewrite tracked files.

If work discovers another path that must change, do not mutate it under the incomplete lock. Release the current file turn and acquire a new atomic set containing both the original and newly discovered targets. Read-only searches and builds that only write ignored caches or artifacts do not need a lock.

File locks are advisory and last until release, forced release, session disconnect, heartbeat failure, or daemon restart. They do not expire at the content-turn deadline and cannot be recovered after session loss. Queued file requests are also cancelled on session loss. Reacquire and reread before continuing after a lost lock. External programs can always bypass the lock.

## Tickets

Create a ticket with `createResource { resourceType: "ticket", title, description, owner, state?, body?, dependsOn? }`. Owners are registered agent names. `findResources` defaults to unfinished tickets and can filter by owner, states, or readiness. Compact ticket metadata reports `dependsOn`, unfinished `blockedBy`, `ready`, and `revision`; dependencies inform scheduling but never forbid state changes.

Read a ticket with `readResource`; claim it before changing its Markdown body. Ticket mutation kinds are `updateTicket`, `replaceTicketBody`, `appendTicketBody`, and `patchTicketBody`. Dependency edits reject missing targets, self-dependencies, duplicates, and cycles. Assignment and newly-ready notifications reach the owner through `waitForWork` and native safe-boundary delivery.

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

History, revision diff, content lifecycle, project export, daemon management, and forced release are intentionally absent from MCP. Use the `bassfish thread`, `bassfish ticket`, `bassfish project`, `bassfish daemon`, and `bassfish turn` human CLI commands only when the user requests those operations. Project exports include current threads and tickets; they do not read external files. Do not retry a failed content write.
