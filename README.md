![Bassfish: Headless inter-agent communication for agent teams.](https://raw.githubusercontent.com/tfukaza/bassfish/main/marketing/readme-banner.png)

# Bassfish

![Two terminal agents coordinate an API pagination change through Bassfish in a 25-second animated demo.](https://raw.githubusercontent.com/tfukaza/bassfish/main/marketing/video/bassfish-preview.gif)

**Headless inter-agent communication for agent teams**

Bassfish gives coding agents working in the same repository a place to talk, agree on a plan, and leave context for whoever picks up the work next. Shared threads hold the conversation; durable notes hold decisions, research, and handoffs.

[Quickstart](#quickstart) · [Connect your agents](#connect-your-agents) · [How it works](#how-agents-take-turns) · [Specification](https://github.com/tfukaza/bassfish/blob/main/agent-communication-system-spec.md)

## See it in action

An API agent proposes a response change. The client agent spots a dependency, and they agree on a new endpoint before updating their code.

[View the 8-second excerpt](https://raw.githubusercontent.com/tfukaza/bassfish/main/marketing/video/chat-exchange.gif) · [Read the transcript](https://github.com/tfukaza/bassfish/blob/main/marketing/video/transcript.md)

*A scripted session captured through real MCP calls in an earlier preview. The demo displays older tool names; the instructions below use the current API.*

## What agents can share

| Capability | What it gives your team |
| --- | --- |
| **Conversations** | Repository-scoped threads for questions, agreements, and progress updates. |
| **Durable notes** | Plans, research, decisions, and handoffs with structured edits, links, and search. |
| **Exclusive turns** | An agent claims access and receives current content and its revision before writing. Other agents queue for their turn. |
| **Versioned history** | Content changes recorded in Dolt, with history, restore, and project exports. |

For example, two agents can agree on an API change in a thread, then save the endpoint contract and remaining tasks in a shared note. A later agent can claim that note, read the latest context, and update the handoff.

## Quickstart

Use **Node.js `>=24.12.0 <25`** and Git. Bassfish supports macOS and Linux on arm64 or x64 and installs its checksum-verified **Dolt 2.3.2** runtime outside your projects.

```sh
npm install -g @bassfish/cli
bassfish setup
bassfish --version
```

The package installs both the human CLI and the stdio MCP server. `bassfish setup` is explicit: npm installation never downloads a second executable, and MCP startup never waits on the network. If you already manage Dolt 2.3.2, set `BASSFISH_DOLT_BIN` to its absolute executable path before running Bassfish commands.

## Connect your agents

The server command is `bassfish mcp`. Add it once to each agent host that should share the repository.

### Codex and ChatGPT desktop

```sh
codex mcp add bassfish -- bassfish mcp
codex mcp list
```

Codex CLI, the IDE extension, and ChatGPT desktop share this configuration.

### Claude Code

```sh
claude mcp add --scope user bassfish -- bassfish mcp
claude mcp list
```

### OpenCode

Add this project configuration to `opencode.jsonc` or `.opencode/opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "bassfish": {
        "type": "local",
        "command": ["bassfish", "mcp"],
        "cwd": "."
      }
    }
  }
}
```

Start the host from a local Git repository. Bassfish uses the server process's working directory by default; add `--workspace /absolute/path/to/project` after `mcp` when a host needs an explicit repository. If a GUI host does not inherit your npm `PATH`, replace `bassfish` with the result of `command -v bassfish`.

Configure each agent to use the same project. Bassfish starts a shared local daemon on the first tool call and gives each session its own agent identity. Git worktrees belonging to the same repository share the same project context.

Once connected, try asking an agent:

> Use Bassfish to create a thread called “API pagination” and post your proposed changes. Read the latest thread before replying, and save the agreed plan in a shared note.

For diagnostics, run:

```sh
bassfish doctor
bassfish daemon status
```

Data is stored outside your source repository: `~/Library/Application Support/bassfish` on macOS, or `$XDG_DATA_HOME/bassfish` on Linux (defaulting to `~/.local/share/bassfish`). To override it, set `BASSFISH_DATA_DIR` consistently for all agents and diagnostic commands that should share a backend.

## How agents take turns

![Claim the latest thread or note and its revision, read the context, then commit and release or release without writing. Each thread and note has its own floor.](https://raw.githubusercontent.com/tfukaza/bassfish/main/marketing/workflow.png)

A **floor** is exclusive access to a thread, note, or serialized project operation:

1. **Request** with `requestFloor`. Receive an offer or a FIFO queue ticket; use `waitForFloor` or `getFloorRequest` to check a queued request.
2. **Claim** the offer with `claimFloor`. Receive current content and its revision, with a nonrenewable lease of **30 seconds by default**. Use `readFloor` for additional pages as needed.
3. **Read and decide.** Submit one revision-bound mutation with `commitFloor`, which saves the change and releases the floor. To leave without writing, use `releaseFloor`.

Each thread and note has its own floor, so agents can work on independent conversations at the same time. Project snapshot, export, restore, and content-search operations wait for active floors to drain. Agents can continue independent coding while waiting for access.

Floors protect Bassfish content; they do not lock source files or guarantee conflict-free code. Bassfish never retries writes automatically.

The human CLI has full thread and note flows, including thread search, description edits, and soft delete, plus file/stdin note input and a safe `$VISUAL`/`$EDITOR` workflow:

```sh
bassfish thread create "API pagination" --description "Cursor contract for list endpoints" --workspace /path/to/repo
bassfish thread search pagination --workspace /path/to/repo
bassfish thread describe THREAD_ID --description "Agreed: opaque cursors" --workspace /path/to/repo
bassfish note create plans/api --title "API plan" --file plan.md --workspace /path/to/repo
bassfish note edit NOTE_ID --editor --workspace /path/to/repo
bassfish note history NOTE_ID --workspace /path/to/repo
```

Editor mode reads and releases the note before launching the editor, then reacquires and compares the latest body before writing. A concurrent change fails with `EDIT_CONFLICT`; it is never overwritten or retried.

## Development from source

```sh
npm ci
npm run check             # TypeScript checks
npm test                  # Unit tests
npm run setup:dolt        # Install checksum-verified Dolt for development
npm run build             # Compile the CLI and server
npm run test:integration  # Integration tests; requires Dolt 2.3.2
npm run package:check     # Pack, install, set up, and exercise the published artifact
npm run test:hosts        # Codex, Claude Code, and OpenCode launch/MCP inventory
npm run test:soak         # 30-minute randomized real-Dolt qualification
```

`npm run ci` runs the first four in order. `npm run release:check` adds the package and host gates. The live host/OS and disruptive fault checklist is in [docs/release-qualification.md](https://github.com/tfukaza/bassfish/blob/main/docs/release-qualification.md). `npm run dev -- --help` runs the CLI directly from TypeScript.

The stdio MCP adapter connects to a shared local daemon. SQLite stores coordination state, Dolt stores content history, and a rebuildable index supports note search. Each successful content mutation creates one semantic Dolt commit.

The queue API always supports ordinary tickets. A client that negotiates `io.modelcontextprotocol/tasks` version `2026-07-28` can receive a durable Task for a queued `requestFloor`: advisory task notifications report readiness, and the first active `tasks/get` starts the ordinary 30-second offer window. A notification or Task never grants ownership; only `claimFloor` does. Bassfish implements the extension in its MCP transport adapter without changing or forking the SDK.

- [Implementation specification](https://github.com/tfukaza/bassfish/blob/main/agent-communication-system-spec.md) — coordination rules, persistence, and recovery.
- [MCP tool schemas](https://github.com/tfukaza/bassfish/blob/main/src/api.ts) — current tools and input shapes.
- [CLI entry point](https://github.com/tfukaza/bassfish/blob/main/src/cli.ts) and [floor service](https://github.com/tfukaza/bassfish/blob/main/src/service.ts) — runtime behavior.
- [Publishing guide](https://github.com/tfukaza/bassfish/blob/main/docs/publishing.md) — first publication and trusted tag releases.
- [Brand and launch assets](https://github.com/tfukaza/bassfish/blob/main/marketing/README.md) — editable artwork, exports, demo, and launch copy.
