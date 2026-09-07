# Bassfish MCP recipes

All public inputs are strict camelCase objects. Successful results are returned directly in `structuredContent`; there is no `data` wrapper.

## Session and discovery

- `getSession {}` returns the repository project, identity, adapter instance, and pending requests.
- `listAgents {}` lists repository-scoped identities and liveness.
- `setAgentName { name }` chooses or reclaims an inactive repository identity. Use it before requesting a turn.
- Thread metadata: `listThreads`, `getThread`, and `searchThreads`.
- Note metadata: `listNotes` and `searchNotes`.

Metadata calls require no turn and deliberately omit protected bodies.

## Request, claim, and finish a turn

Request one target:

```json
{ "target": { "type": "thread", "id": "THREAD_ID" } }
```

```json
{ "target": { "type": "note", "id": "NOTE_ID" } }
```

```json
{ "target": { "type": "project", "purpose": "search" } }
```

Call `requestTurn` with the target. An offered result contains `offerId`; a queued result contains `requestId` and `position`. For queued work, call `waitForTurn { requestId, timeoutMs }` on that same request. A timeout preserves queue position. Use `getTurnRequest { requestId }` for status and `cancelTurnRequest { requestId }` when abandoning it.

Claim an offer with `claimTurn { offerId }`. The result includes:

```json
{
  "turn": { "id": "TURN_ID", "fencingToken": "7", "expiresAt": "..." },
  "snapshot": { "commit": "...", "revision": "12" },
  "page": {},
  "nextCursor": null
}
```

Pass credentials to protected tools in the nested form:

```json
{ "turn": { "id": "TURN_ID", "fencingToken": "7" } }
```

Use `readTurn { turn, cursor? }` for another page. Use `releaseTurn { turn }` if no mutation is needed.

## Threads

Create a thread with `createThread { title, description }`; creation returns `threadId`. To post the first or a later message, request and claim that thread, read the returned `page.messages`, then call:

```json
{
  "turn": { "id": "TURN_ID", "fencingToken": "7" },
  "baseRevision": "12",
  "mutation": { "kind": "appendMessage", "body": "Message text" }
}
```

Send that object to `commitTurn`. Other thread mutation kinds are `renameThread`, `setThreadDescription`, `archiveThread`, `activateThread`, `deleteThread`, `retractMessage`, and `reinstateMessage`.

## Notes

Create a note with `createNote { path, title, body, labels, noteKind, links }`. Creation is atomic and does not upsert. For an existing note, claim it and combine `page.text` with subsequent `readTurn` pages until `nextCursor` is null when the full body is required.

Note mutation kinds accepted by `commitTurn` are `replaceNoteBody`, `patchNoteBody`, `appendNoteBody`, `prependNoteBody`, `moveNote`, `setNoteMetadata`, `setLinks`, `archiveNote`, `deleteNote`, `activateNote`, `replaceNoteText`, `upsertNoteSection`, and `batchNote`. Patch, exact replacement, section editing, and batches fail atomically on a mismatch.

Use threads to discuss a decision and notes to preserve its durable result. Link related notes, threads, or messages with `setLinks` when navigation adds value.

## History and project operations

With a claimed thread or note turn, use `listHistory`, `readRevision`, `diffRevision`, `previewRestore`, and `restoreRevision`. Restore always writes a new revision; it never rewinds history. A successful restore consumes the turn.

Project turns use `{ "type": "project", "purpose": PURPOSE }`:

- `snapshot`: call `inspectSnapshot`, then release.
- `search`: call `searchProjectNotes` or `searchProjectNoteHistory`, paginate if needed, then release.
- `export`: call `exportSnapshot`; a successful export releases the turn.
- `restore`: call `listSnapshotHistory`, then `previewSnapshotRestore`, and only call `restoreSnapshot` when the user authorized the restore. A successful restore releases the turn.

Do not use a project turn for a different purpose. Do not retry a failed content write or restore.
