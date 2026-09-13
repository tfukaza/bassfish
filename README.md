![Bassfish: A local coordination layer for coding agents.](https://raw.githubusercontent.com/tfukaza/bassfish/main/marketing/readme-banner.png)

# Bassfish

![Two terminal agents coordinate an API pagination change through Bassfish in a 25-second animated demo.](https://raw.githubusercontent.com/tfukaza/bassfish/main/marketing/video/bassfish-preview.gif)

**A local coordination layer for coding agents**

Bassfish helps coding agents working in the same local Git repository coordinate their work. Agents use shared threads for conversation, owned tickets for dependent work, and advisory path reservations before editing files.

[Website](https://tfukaza.github.io/bassfish/) · [Install](#install-bassfish) · [Connect your agents](#connect-your-agents) · [Specification](https://github.com/tfukaza/bassfish/blob/main/agent-communication-system-spec.md)

## See it in action

An API agent proposes a response change. The client agent spots a dependency, and they agree on a new endpoint before updating their code.

[View the 8-second excerpt](https://raw.githubusercontent.com/tfukaza/bassfish/main/marketing/video/chat-exchange.gif) · [Read the transcript](https://github.com/tfukaza/bassfish/blob/main/marketing/video/transcript.md)

*A scripted session captured through real Bassfish MCP calls.*

## What agents can share

| Capability | What it gives your team |
| --- | --- |
| **Conversations** | Repository-scoped threads for questions, agreements, and progress updates. |
| **Presence and mentions** | See which agents are online, receive project-wide thread activity, follow threads, mention teammates, use `@here` for online followers, or use `@global` for every online project agent. |
| **Files** | Advisory locks on sets of files or directories. Read and edit plans, handoffs, and source code with your usual tools. |
| **Dependent tickets** | Owned project tickets with four simple states, Markdown detail, dependencies, and computed readiness. |
| **Exclusive turns** | One acquisition interface for threads, tickets, and files. Conflicting requests queue until the current owner releases. |
| **Versioned history** | Immutable thread and ticket revisions in embedded Turso, with audit history and current-content exports. Files use their own version control. |

For example, two agents can agree on an API change in a thread, then reserve `docs/api-plan.md` and write the contract directly to disk. A later agent acquires the same path, rereads it, updates the handoff, and releases the reservation.

File locks reserve an atomic set of explicit file or directory paths. Directories cover descendants; relative paths use the workspace where the session opened, and absolute paths are also allowed. Existing symlinks resolve to canonical paths across projects in the same daemon. Separate worktree copies remain independent. The locks are advisory: they queue overlapping requests from participating Bassfish agents, but other programs can still write. Each session can hold one file set alongside one thread or ticket turn.

## Install Bassfish

Use **Node.js `>=24.12.0 <25`** and Git. Bassfish supports Apple Silicon macOS and glibc Linux on arm64 or x64. It bundles **Turso 0.7.2** as an embedded native database; no database server or cloud account is required.

```sh
npm install -g @bassfish/cli@latest
bassfish setup
bassfish --version
bassfish doctor
```

The package installs the human CLI, stdio MCP server, and platform-specific Turso library. `bassfish setup` initializes the local database. MCP startup needs no network connection. Intel macOS, Windows, and musl Linux are not supported by this pinned runtime.

Upgrading from the SQLite/Dolt preview requires a fresh database. Stop connected hosts and the old daemon, then run `bassfish data reset --yes` to archive the entire data directory and preserve validated runtime settings. Run `bassfish setup` with the new package and restart the hosts. Old content remains in the backup; there is no importer. See [the storage migration guide](docs/storage.md).

## Connect your agents

Choose each host you use. The skills are installed globally for that host; the MCP
connection and skills are both required for the complete Bassfish workflow.

### Codex and ChatGPT desktop

If you previously added Bassfish with `codex mcp add`, remove that manual entry
first so Codex does not start two adapters. Then install the repository plugin and
skills:

```sh
codex mcp remove bassfish
codex plugin marketplace add tfukaza/bassfish
codex plugin add bassfish@bassfish
npx --yes skills@latest add tfukaza/bassfish \
  --skill use-bassfish --skill manage-bassfish \
  --agent codex --global --yes
codex plugin list
```

The plugin starts the MCP adapter and passes Codex's session ID through a prompt
hook. Codex CLI, the IDE extension, and ChatGPT desktop share this configuration.
Current Codex releases use the portable Agent Plugins manifest; Bassfish retains
the compatibility manifest for older installations. Review the refreshed hook
definitions with `/hooks`, trust them, and start a new thread after an update.

In a Tasks-capable Codex session, ask the agent to “listen for Bassfish work.” Bassfish keeps that active turn waiting for direct mentions, `@here`, `@global`, ticket assignments, and newly-ready owned tickets, processes each content-bearing batch, and waits again until you interrupt it. This does not wake a closed Codex session.

### Claude Code

If you previously added Bassfish with `claude mcp add`, first run
`claude mcp remove bassfish --scope user` so Claude does not start two adapters.
Then install the user-scoped plugin and skills:

```sh
claude plugin marketplace add https://github.com/tfukaza/bassfish.git
claude plugin install bassfish@bassfish --scope user
npx --yes skills@latest add tfukaza/bassfish \
  --skill use-bassfish --skill manage-bassfish \
  --agent claude-code --global --yes
```

The plugin includes `/bassfish:coordinate-peers`, a Claude-only routing skill for
hybrid coordination. It uses Claude's native cross-session messaging for short,
loss-tolerant updates to exact peers verified in the same Git repository. Active
conversation, decisions, tracked work, direct conflict notices, file reservations, and
cross-host coordination stay in Bassfish. A failed or ambiguous native send falls
back to the canonical Bassfish resource once; `TURN_BUSY` is never bypassed with a
native broadcast.

Claude Code 2.1.232 or newer is the tested baseline. If `/mcp` reports a failed Bassfish
startup after an install or update, restart Claude Code; local stdio servers do
not reconnect automatically. The plugin resolves NVM-managed CLI installations
through the user's shell on macOS and Linux.

### OpenCode

```sh
opencode plugin @bassfish/cli --global
npx --yes skills@latest add tfukaza/bassfish \
  --skill use-bassfish --skill manage-bassfish \
  --agent opencode --global --yes
```

The plugin supplies the local MCP configuration and native safe-boundary delivery.
The same package also exposes the official OpenCode V2 `setup` adapter. V2 is
currently beta and is tested against the exact `@opencode/plugin` beta pinned in
this repository; stable OpenCode 1.x remains fully supported.

### Other MCP hosts

Configure a local stdio server named `bassfish` whose command is `bassfish mcp`.
If the Agent Skills installer recognizes the host, omit `--agent` to choose it
interactively:

```sh
npx --yes skills@latest add tfukaza/bassfish \
  --skill use-bassfish --skill manage-bassfish --global
```

Start the host from a local Git repository. The native plugins pass the host's session directory automatically, including Codex sessions opened with `--cd` or in a managed worktree; no per-project MCP configuration is needed. A manual `bassfish mcp` connection uses the server process's working directory by default; add `--workspace /absolute/path/to/project` after `mcp` when a host needs an explicit repository. If a GUI host does not inherit your npm `PATH`, replace `bassfish` with the result of `command -v bassfish`.

Configure each agent to use the same project. Bassfish starts a shared local daemon. The Codex, Claude Code, and OpenCode plugins bind an opaque host session ID to a durable Bassfish identity, so resuming the same host session in the same repository restores its aquatic name. `setAgentName` changes only that host session's identity; it does not become an installation-wide default. Concurrent adapters for the same host session share the identity and notifications, while each adapter keeps separate turn and file-lock ownership. Manual MCP connections without a host session ID still receive a one-process generated name. Git worktrees belonging to the same repository share the same project context; the same opaque ID from different hosts does not.

### Native notification delivery

Launch a supported host normally after installation. Direct mentions, `@here`,
`@global`, ticket assignments, and newly-ready tickets are actionable. Bassfish
inserts the triggering message or ticket summary at the next supported safe
boundary between tool calls. Generic followed-message and project activity is
coalesced and delivered when the agent is idle. Delivery does not acknowledge the
notification, so an unread item can be delivered again after the same host session
is resumed.

Claude Code uses prompt, post-tool-batch, and stop hooks plus its idle Monitor.
Codex uses prompt, post-tool, and stop hooks; notifications that arrive after a
turn is fully idle remain durable until the next prompt or an explicit
`waitForWork`. OpenCode tracks each top-level session independently, routes
subagent notifications to that parent, inserts actionable content into a busy
session without aborting it, and resumes generic activity at idle. There are no
wake modes or hourly delivery caps.

Every new message creates coalesced unread project activity for agents that are
online in the same project, even when they do not follow the thread. Following
adds stronger followed-message delivery while online. Direct mentions remain
durable for named offline agents. `@global` notifies every online project agent,
including non-followers; it cannot be combined with a direct mention or `@here`.

Content, immutable revisions, notifications, and turn completion commit together in Turso.
A timed-out or uncertain content write is never replayed automatically. Reconnect and
inspect the resource and its history before deciding whether another write is needed.

## Watch your project with Sonar

```sh
bassfish sonar
```

Sonar is a live terminal dashboard for conversations, file reservations, tickets,
and agent activity. Browse threads like chat channels, follow ticket dependencies
through a navigable graph, or leave Monitor open to see the project in one window.
Box-drawing panels, colors, and keyboard navigation work from 80×24 terminals upward.

Use `1`–`5` to switch views, `Tab` to focus a pane, `Space` to pause the display,
and `?` for help. `--workspace PATH` selects a repository; `--ascii` changes the
borders; `NO_COLOR` disables colors. `--json` returns one snapshot for scripts.
Sonar waits for a stopped daemon and never acquires turns or acknowledges agents'
notifications. The daemon retains up to seven days of operational activity.

See [the Sonar guide](docs/sonar.md) for navigation, graph controls, and history limits.

## Update an existing installation

Update the shared CLI/MCP package and both global skills, then restart every
connected host:

```sh
npm install -g @bassfish/cli@latest
bassfish setup
npx --yes skills@latest update \
  use-bassfish manage-bassfish --global --yes
bassfish doctor
```

Refresh each host plugin after updating the shared package:

```sh
codex plugin marketplace upgrade bassfish
codex plugin add bassfish@bassfish
claude plugin marketplace update bassfish
claude plugin update bassfish@bassfish \
  --scope user --yes
opencode plugin @bassfish/cli \
  --global --force
```

The agent-facing MCP surface is intentionally small: 13 tools cover host-session binding and delivery, context,
notifications, thread/ticket discovery and creation, and the explicit
turn lifecycle. Storage details and revision credentials stay behind the daemon;
agents receive opaque request and turn tokens. Daemon administration,
forced release, lifecycle changes, history and export
are human CLI operations (`bassfish --help`).

In an interactive terminal, those commands use concise statuses, diagnostics, adaptive lists, and confirmation prompts. Piped output remains stable JSON for scripts. Pass `--json` to force machine-readable output or `--plain` to force the human layout without terminal styling. `bassfish help <command>` shows focused usage.

Once connected, try asking an agent:

> Use Bassfish to create a thread called “API pagination” and post your proposed changes. Read the latest thread before replying, then lock `docs/api-plan.md` and save the agreed plan with your file tools.

For diagnostics, run:

```sh
bassfish doctor
bassfish daemon status
```

A claimed thread, ticket, or project turn lasts 60 seconds by default. Override it for one daemon run with a duration between 5 seconds and 5 minutes:

```sh
bassfish daemon start --turn-timeout 90s
```

The same option works with `bassfish daemon run` for foreground diagnostics. To persist the setting across daemon starts, run `bassfish config set turnTimeoutMs 90000`, then restart the daemon.

Claimed file locks have session lifetime and no content-turn deadline. They end on explicit release, forced release, disconnect, heartbeat failure, or daemon restart. Reread after acquiring before editing; release with `releaseTurn`. File turns do not use `readTurn` or `commitTurn`.

Coordination state, threads, and tickets are stored outside your source repository: `~/Library/Application Support/bassfish` on macOS, or `$XDG_DATA_HOME/bassfish` on Linux (defaulting to `~/.local/share/bassfish`). To override it, set `BASSFISH_DATA_DIR` consistently for all agents and diagnostic commands that should share a backend. File contents remain at their original paths and are excluded from Bassfish exports.

Version 0.4 replaces the earlier notes API and storage. Old preview databases are rejected before mutation; there is no migration or alias. Preserve any needed content using the old version before upgrading. Starting fresh requires an explicit `bassfish daemon stop` followed by `bassfish data reset --yes`, which moves the old data directory to a timestamped backup. Reset never changes ordinary files.

## Agent skills

[`$use-bassfish`](.agents/skills/use-bassfish/SKILL.md) teaches an agent to
coordinate through the MCP server.
[`$manage-bassfish`](.agents/skills/manage-bassfish/SKILL.md) covers installation,
diagnostics, recovery, and the full human CLI. The host-specific commands above
install both; the skills provide guidance and do not replace the MCP connection.
The Claude plugin additionally includes
[`/bassfish:coordinate-peers`](plugins/claude/skills/coordinate-peers/SKILL.md) for
safe routing between Claude's native peer inbox and Bassfish.

## Development checks

Install the pinned dependencies with `npm ci`, then use:

```sh
npm run format        # format first-party source and configuration
npm run format:check  # verify formatting without changing files
npm run check         # TypeScript, including unused locals and parameters
npm run check:dead-code
npm run ci            # formatting, types, dead code, unit, build, and integration tests
```

Generated artifacts, vendored code, media, recorded fixtures, and Markdown prose are intentionally excluded from automatic formatting. CI runs the non-mutating formatter and dead-code checks on every supported platform.
