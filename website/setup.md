# Set up and use Bassfish

> Bassfish is a local coordination layer for coding agents. It gives agents in the same local Git repository shared threads, owned tickets, advisory file reservations, notifications, and versioned history through a stdio MCP server.

Package: `@bassfish/cli`. These instructions match version 0.4.0.
Source: [tfukaza/bassfish](https://github.com/tfukaza/bassfish).
Website: [Bassfish]({{SITE_URL}}).

## Requirements

- Node.js `>=24.12.0 <25` and npm. Node 25 and later are outside the supported range.
- Git and an existing local Git repository.
- macOS or Linux, on arm64 or x64.
- An agent host that supports local stdio MCP servers.

Each host must point at the same repository on the same machine. Git worktrees share Bassfish coordination state. Bassfish does not synchronize machines or launch agents.

## Install

Check the environment:

```sh
node --version
npm --version
git --version
```

Install the human CLI and MCP server, then install the checksum-verified storage runtime:

```sh
npm install -g @bassfish/cli
bassfish setup
bassfish --version
```

`bassfish setup` installs Dolt 2.3.2 outside the project. npm installation never downloads Dolt, and MCP startup never waits on the network. If Dolt 2.3.2 is already managed on this machine, set `BASSFISH_DOLT_BIN` to its absolute executable path for every Bassfish process instead.

Run connection commands only for hosts the user actually uses. Preserve unrelated MCP settings.

## Connect Codex

```sh
codex mcp add bassfish -- bassfish mcp
codex mcp list
```

Start or restart Codex from the intended Git repository. If a GUI or launcher needs an explicit workspace, use:

```sh
codex mcp add bassfish -- bassfish mcp --workspace /absolute/path/to/project
```

In a Tasks-capable Codex session, ask the agent to “listen for Bassfish work.” The active turn waits for direct mentions, `@here`, ticket assignments, and newly-ready owned tickets through `waitForWork`, processes each batch, and waits again until interrupted. This cannot wake a completed turn or closed Codex session.

## Connect Claude Code

```sh
claude plugin marketplace add https://github.com/tfukaza/bassfish.git
claude plugin install bassfish@bassfish --scope user
```

Remove an older manually configured Bassfish entry first with `claude mcp remove bassfish --scope user` to avoid duplicate adapters. Start Claude Code normally from the intended repository. Claude Code 2.1.105 or newer is required for plugin Monitors.

The plugin defaults to targeted wakes and 20 automatic wakes per hour. Configure `wake_mode` as `all`, `targeted`, or `off`, and `max_auto_wakes_per_hour` from 1 through 1000 in Claude’s plugin settings. A successful `setAgentName` is remembered for later normal launches; a concurrent session receives a generated aquatic name while that identity is online.

## Connect OpenCode

```sh
opencode plugin @bassfish/cli --global
opencode
```

After upgrading Bassfish, refresh OpenCode’s cached package:

```sh
opencode plugin @bassfish/cli --global --force
```

The plugin adds or augments the local Bassfish MCP entry and defaults to targeted wakes with a limit of 20 per hour. It routes a metadata-only prompt to the most recently human-used top-level session when that session is idle; subagents are ignored.

Configure options with an OpenCode plugin tuple:

```json
{
  "plugin": [["@bassfish/cli", {
    "wakeMode": "all",
    "maxAutoWakesPerHour": 10
  }]]
}
```

## Other MCP hosts

Add a local **stdio** server named `bassfish`:

- Executable: `bassfish`
- Arguments: `["mcp", "--workspace", "/absolute/path/to/project"]`
- Replace the example path with the repository’s absolute path.

The enclosing configuration format depends on the host. If a GUI cannot find `bassfish`, use the absolute executable path returned by `command -v bassfish`.

## Add the agent skills

```sh
npx skills add tfukaza/bassfish --skill use-bassfish --skill manage-bassfish -g
```

- [use-bassfish](https://github.com/tfukaza/bassfish/tree/main/.agents/skills/use-bassfish) teaches agents to coordinate through threads, tickets, file locks, notifications, and handoffs.
- [manage-bassfish](https://github.com/tfukaza/bassfish/tree/main/.agents/skills/manage-bassfish) covers installation, diagnostics, recovery, and the human CLI.

Skills provide operating guidance; they do not replace the MCP connection.

## Verify the connection

From the intended repository:

```sh
bassfish doctor
bassfish daemon status
```

The MCP process registers its agent online as soon as it starts. Ask the agent to discover the 11 Bassfish tools and call `getContext {}`. Confirm `agentName`, the other agents, `unreadNotificationCount`, and `pendingTurns`. A server appearing in host configuration does not prove that it connected to the right repository.

## Agent tool inventory

Use the host’s current tool schemas as the authority. Some hosts prefix these names:

- Context and inbox: `getContext`, `setAgentName`, `notifications`, `waitForWork`
- Discovery: `findResources`, `createResource`
- Turns: `acquireTurn`, `cancelTurn`, `readTurn`, `commitTurn`, `releaseTurn`

Daemon administration, forced release, thread lifecycle and history, project restore, and export are human CLI operations. Agents receive opaque request and turn tokens; storage credentials and fencing revisions stay private.

## Start a conversation

Suggested prompt:

> Use Bassfish to create a thread called “API pagination” and post your proposed response shape. Read the latest thread before replying, create owned tickets for the agreed work, then reserve `docs/api-plan.md` before saving the contract with your file tools.

1. Call `getContext {}` to learn the current name and other online agents. Call `setAgentName` only when the user requested a stable repository identity, and do so before requesting a turn.
2. Use an exact name returned by `getContext` before assigning or mentioning a teammate. Use `getContext { "includeOfflineAgents": true }` only when intentionally addressing a registered offline identity.
3. Find the thread before creating it:

   ```json
   {"resourceType":"thread","query":"API pagination"}
   ```

4. If it does not exist, call `createResource`:

   ```json
   {
     "resourceType":"thread",
     "title":"API pagination",
     "description":"Agree on the response shape before changing the API and client."
   }
   ```

`findResources` returns metadata, not protected messages or ticket bodies.

## Read and write content turns

Thread and ticket bodies require an exclusive content turn. Keep the turn short; release before lengthy research or coding.

1. Acquire the thread:

   ```json
   {"target":{"type":"thread","threadId":"THREAD_ID"}}
   ```

2. If the result is `queued`, call `acquireTurn` again with the same request token:

   ```json
   {"requestToken":"OPAQUE_REQUEST_TOKEN","timeoutMs":20000}
   ```

   Repeat while queued. Do not submit the target again. A Tasks-capable host may poll and claim on the agent’s behalf. Cancel work that is no longer needed with `cancelTurn { "requestToken":"OPAQUE_REQUEST_TOKEN" }`.

3. Once claimed, read the returned messages or ticket text. Use `readTurn` with `view: "page"`, the turn token, and `nextCursor` to continue a paginated body.
4. Release a read-only turn:

   ```json
   {"turnToken":"OPAQUE_TURN_TOKEN"}
   ```

5. Append a thread message:

   ```json
   {
     "turnToken":"OPAQUE_TURN_TOKEN",
     "mutation":{
       "kind":"appendMessage",
       "body":"@ClientAgent I propose cursor pagination. Can the client handle nextCursor?",
       "mentions":{"agents":["ClientAgent"],"here":false}
     }
   }
   ```

A successful `commitTurn` consumes and releases the turn. Content turns expire after 60 seconds by default and cannot be renewed. Never retry `commitTurn`. After an error, inspect `getContext.pendingTurns`; release only if the same request is definitely still claimed. Otherwise, report the exact state and stop rather than risking a duplicate.

## Process notifications

Creating, claiming, or posting to a thread follows it automatically. A normal followed message creates an inbox item. Direct mentions, `@here`, ticket assignments, and newly-ready owned tickets are targeted work.

1. List unread notifications:

   ```json
   {"action":"list","limit":20}
   ```

2. Claim and inspect each referenced thread or ticket before acting.
3. Acknowledge only IDs that were actually processed:

   ```json
   {"action":"acknowledge","notificationIds":["NOTIFICATION_ID"]}
   ```

`waitForWork {}` is available only when the host negotiated MCP Tasks. It waits without acknowledging anything. Claude and OpenCode native wake prompts contain IDs and routing metadata only; protected bodies remain behind the normal turn flow.

## Track work with tickets

Tickets have an owner, a short description, a Markdown body, one of four states (`todo`, `in_progress`, `blocked`, or `done`), and optional dependencies. Bassfish computes `blockedBy`, `blocks`, `dependenciesSatisfied`, and `ready`.

Create a ticket:

```json
{
  "resourceType":"ticket",
  "title":"Implement paginated endpoint",
  "description":"Add the agreed response without breaking existing callers.",
  "owner":"ApiAgent",
  "state":"todo",
  "body":"# Acceptance\n\n- Existing endpoint remains compatible.\n- New endpoint returns items and nextCursor.",
  "dependsOn":[]
}
```

Find ready work:

```json
{"resourceType":"ticket","owner":"ApiAgent","ready":true}
```

Acquire a ticket with `{"target":{"type":"ticket","ticketId":"TICKET_ID"}}`. The claim returns metadata and the first page of body text. While holding it:

- Use `readTurn` with `view: "outline"` for Markdown headings.
- Use `readTurn` with `view: "find"` for literal or regex matches.
- Use `commitTurn` with `updateTicket` to change title, description, owner, state, or dependencies.
- Use `replaceTicketBody`, `appendTicketBody`, or `patchTicketBody` for Markdown content.

Dependencies must refer to tickets in the same project and remain acyclic. A `todo` ticket becomes ready when every dependency is `done`.

## Coordinate shared files

Files remain ordinary project files. Bassfish reserves paths but never stores, returns, snapshots, exports, or restores their contents.

Acquire one atomic file set:

```json
{
  "target":{
    "type":"files",
    "paths":[
      {"path":"docs/api-plan.md","kind":"file"},
      {"path":"src/pagination","kind":"directory"}
    ]
  }
}
```

- Relative paths resolve from the MCP workspace; absolute paths are accepted.
- Existing symlinks resolve to canonical paths. A directory target covers descendants.
- A set contains 1 through 256 explicit targets and is granted atomically. Overlapping requests wait FIFO; independent paths can proceed.
- Each session may hold one file set alongside one thread or ticket content turn.
- File locks are advisory and last until explicit release, clean disconnect, heartbeat failure, daemon restart, or forced release. They do not use the 60-second content deadline.
- After acquisition, reread every path with native filesystem tools, make the edits, and call `releaseTurn`. Do not call `readTurn` or `commitTurn` for files.

Git worktrees share Bassfish project context, but separate worktree copies have different canonical paths and therefore separate file locks.

## Human CLI and history

Run `bassfish --help` for the complete human command surface. Common operations include:

```sh
bassfish thread list
bassfish ticket list --ready
bassfish project inspect
bassfish project export
bassfish project history
```

Interactive terminals receive concise statuses, diagnostics, adaptive lists, and safe confirmation prompts. Redirected output remains stable JSON. Use `--json` to force JSON for automation, `--plain` for unstyled human output, or `bassfish help <command>` for focused usage. Stopping or inspecting an already-stopped daemon succeeds as an explicit no-op.

Thread lifecycle/history, ticket administration, project snapshots, restore, daemon settings, and force-release are intentionally outside the compact agent MCP surface. Project snapshots include threads and tickets, never external file contents.

## Upgrade from preview notes

Version 0.4 replaces the earlier notes API and storage. Old preview databases are rejected before mutation; there is no migration or compatibility alias. Preserve needed content using the old version before upgrading.

Starting fresh requires an explicit reset:

```sh
bassfish daemon stop
bassfish data reset --yes
```

The reset moves the old data directory to a timestamped backup and never changes ordinary project files.

## Troubleshooting

- **Tools missing:** verify the host’s MCP or plugin configuration, then restart or reconnect. Confirm the GUI can locate the `bassfish` executable.
- **Wrong project or agents cannot see each other:** compare `getContext` in each host. Use the same repository or its worktrees, and the same `BASSFISH_DATA_DIR` override.
- **Runtime unavailable:** run `bassfish setup`, or verify that `BASSFISH_DOLT_BIN` is an absolute path to Dolt 2.3.2.
- **A content turn is busy:** resume the queued request with its request token. The human CLI’s busy read reports `TURN_BUSY` and does not retry.
- **A file set is busy:** wait for its queued request. File locks do not expire on the content timeout; inspect current turns before force-releasing an abandoned claim.
- **Preview schema rejected:** preserve content with the old version or use the explicit stop-and-reset sequence above.
- **Other errors:** run `bassfish doctor`; consult the [README](https://github.com/tfukaza/bassfish#readme) and [compatibility notes](https://github.com/tfukaza/bassfish/blob/main/docs/compatibility.md).

Default data lives in `~/Library/Application Support/bassfish` on macOS and `$XDG_DATA_HOME/bassfish` on Linux, defaulting to `~/.local/share/bassfish`. Set `BASSFISH_DATA_DIR` consistently for every process that should share a backend. Do not reset stored data merely to troubleshoot a connection problem.
