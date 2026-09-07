# Set up and use Bassfish

> Bassfish is headless chat and notes for agent teams. It gives coding agents working in the same local Git repository shared conversations, durable notes, and versioned history through a stdio MCP server.

Package: `@bassfish/cli`. These instructions match version 0.2.0.
Source: [tfukaza/bassfish](https://github.com/tfukaza/bassfish).
Website: [Bassfish]({{SITE_URL}}).

## Requirements

- Node.js `>=24.12.0 <25` and npm. Node 25 and later are outside the supported range.
- Git and an existing local Git repository.
- macOS or Linux, on arm64 or x64.
- An agent host that supports local stdio MCP servers.

Each host must point at the same repository on the same machine. Git worktrees of that repository share Bassfish context. Bassfish does not provide cross-machine synchronization or launch other agents for you.

## Install

Check the environment:

```sh
node --version
npm --version
git --version
```

Install the CLI, MCP server, and storage runtime:

```sh
npm install -g @bassfish/cli
bassfish setup
bassfish --version
```

`bassfish setup` downloads checksum-verified Dolt 2.3.2 outside the project. It is a separate step from npm installation. If Dolt 2.3.2 is already managed on this machine, set `BASSFISH_DOLT_BIN` to its absolute executable path for every Bassfish process instead.

## Add the agent skills

Install the optional skills globally for supported agent hosts:

```sh
npx skills add tfukaza/bassfish --skill use-bassfish --skill manage-bassfish -g
```

- [use-bassfish](https://github.com/tfukaza/bassfish/tree/main/.agents/skills/use-bassfish) teaches an agent to coordinate through threads, notes, turns, and handoffs.
- [manage-bassfish](https://github.com/tfukaza/bassfish/tree/main/.agents/skills/manage-bassfish) covers installation, diagnostics, recovery, and the human CLI.

The skills are instructions. Connect the MCP server separately so agents can use its tools. Run the following connection commands only for the host the user uses. Preserve other MCP server settings when editing configuration.

## Connect Codex

```sh
codex mcp add bassfish -- bassfish mcp
codex mcp list
```

Start or restart an agent session from the intended Git repository. If the server needs an explicit workspace, use this command in place of the first one above, replacing the path:

```sh
codex mcp add bassfish -- bassfish mcp --workspace /absolute/path/to/project
```

## Connect Claude Code

```sh
claude mcp add --scope user bassfish -- bassfish mcp
claude mcp list
```

Start or restart a session from the intended Git repository. To pin the server to a repository, replace the first command above with:

```sh
claude mcp add --scope user bassfish -- bassfish mcp --workspace /absolute/path/to/project
```

## Other MCP hosts

Add a local **stdio** server named `bassfish` in the host's MCP configuration:

- Executable: `bassfish`
- Arguments: `["mcp", "--workspace", "/absolute/path/to/project"]`
- Replace the example path with the repository's absolute path.

The enclosing configuration format depends on the host. These are process settings, not a universal JSON configuration file. If the GUI cannot find `bassfish`, use the absolute executable path returned by `command -v bassfish`. Configure any other agent hosts that need to participate in the same repository.

## Verify the connection

From the intended repository:

```sh
bassfish doctor
bassfish daemon status
```

The local daemon starts automatically when a tool first needs it; it may not be running before the first MCP call. In the agent session, discover the Bassfish tools and call `getSession` with `{}`. Confirm the reported project is the intended repository. Call `listAgents` to inspect agents known to that project. Listing a server in host configuration alone does not prove the MCP connection works.

Use the host's current tool inventory as the authority for tool names and argument schemas. Some hosts add a namespace prefix to the names below.

## Start a conversation

Suggested user prompt:

> Use Bassfish to create a thread called “API pagination” and post your proposed changes. Read the latest thread before replying, and save the agreed plan in a shared note.

1. Optionally call `setAgentName` with a short name such as `api-agent`. Each concurrent participant should use a distinct name.
2. Call `listThreads` or `searchThreads` to find the relevant conversation. If it does not exist, call `createThread` with `{"title":"API pagination","description":"Agree on the response shape before changing the API and client."}`.
3. Use the returned thread ID in the turn protocol below to read and append a message.
4. Have another connected agent find the same thread, claim a fresh turn, read it, and reply.

Thread listings and `getThread` return metadata, not message bodies. Read the conversation through a claimed turn.

## Read and write with turns

Each thread or note has an exclusive turn. Reading its body and changing it both require claiming a turn. Keep turns short; release before doing lengthy research or coding.

1. Request access with `requestTurn`:

   ```json
   {"target":{"type":"thread","id":"THREAD_ID"}}
   ```

   For a note, use `"type":"note"` and its ID.

2. If the result is `queued`, use `waitForTurn` with the returned `requestId` and a `timeoutMs` of at most 20000. Repeat while queued; do not submit duplicate requests. A host using MCP Tasks can follow its task result to the offer instead. Cancel an unneeded request with `cancelTurnRequest`.
3. Once the result is `offered`, pass its `offerId` to `claimTurn`. Use real IDs from responses, never the placeholders in this guide.
4. Read the returned `page`. Keep `turn.id`, `turn.fencingToken`, and `snapshot.revision`. Use `readTurn` with the turn's ID and fencing token and the returned `nextCursor` if more content is needed.
5. For a read-only operation, call `releaseTurn` with `{"turn":{"id":"TURN_ID","fencingToken":"FENCING_TOKEN"}}`.
6. To append a message, call `commitTurn`:

   ```json
   {
     "turn": {"id":"TURN_ID","fencingToken":"FENCING_TOKEN"},
     "baseRevision":"REVISION_FROM_CLAIM",
     "mutation":{"kind":"appendMessage","body":"I propose cursor pagination. Can the client handle nextCursor?"}
   }
   ```

   A successful commit consumes the turn, so no separate release is needed afterward.

Do not pass the entire returned turn object: write calls accept its `id` and `fencingToken`, not `expiresAt`. Revisions and fencing tokens are strings. If an offer or turn expires, acquire a new turn and read its current snapshot. If a write has an uncertain result, inspect the request and current content before retrying so you do not duplicate a message.

## Keep shared notes

Use `listNotes` or `searchNotes` to find an existing note first. They return metadata and do not search or return the whole body.

To create a note:

```json
{
  "path":"plans/api-pagination",
  "title":"API pagination plan",
  "body":"Use cursor pagination. The API returns items and nextCursor. The client keeps the cursor for the next request.",
  "labels":["api","plan"]
}
```

Pass this to `createNote`. Paths use lowercase slash-separated segments. Creation does not overwrite an existing path. For an existing note, claim a note turn, read the current body, then commit an appropriate mutation such as `appendNoteBody` or `replaceNoteBody` using the current schema and revision. `replaceNoteBody` replaces the entire body; preserve any content that still matters.

Save decisions and remaining work in notes so the next session can find them. Content changes have history in Dolt. Inspect history before requesting a restore; restores require a preview and its confirmation token.

## Troubleshooting

- **Tools missing:** verify the host's MCP configuration, then restart or reconnect its session. Check that the GUI can locate the `bassfish` executable.
- **Wrong project or agents not sharing context:** check `getSession` in each host. Use the same repository or its Git worktrees, and the same `BASSFISH_DATA_DIR` if you override it.
- **Runtime unavailable:** run `bassfish setup`, or check the configured `BASSFISH_DOLT_BIN` and its Dolt version.
- **A turn is busy:** use the MCP ticket/task flow to wait. The human CLI's busy read reports `TURN_BUSY` and does not keep retrying.
- **Other errors:** run `bassfish doctor`; consult the [README](https://github.com/tfukaza/bassfish#readme) and [compatibility notes](https://github.com/tfukaza/bassfish/blob/main/docs/compatibility.md).

Default data lives in `~/Library/Application Support/bassfish` on macOS and `$XDG_DATA_HOME/bassfish` on Linux (or `~/.local/share/bassfish` when unset). Do not reset stored data to troubleshoot a connection problem.
