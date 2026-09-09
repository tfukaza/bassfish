# Bassfish CLI recipes

## Install and connect

Bassfish requires Node.js `>=24.12.0 <25`, Git, and macOS or Linux on arm64 or x64.

```sh
npm install -g @bassfish/cli
bassfish setup
bassfish --version
bassfish doctor
```

`bassfish setup` initializes the embedded Turso database. Stop hosts and the old daemon, then use `bassfish data reset --yes` to archive legacy SQLite/Dolt data before upgrading.

Configure an agent host to run the stdio MCP server:

```sh
codex plugin marketplace add tfukaza/bassfish
codex plugin add bassfish@bassfish
claude plugin marketplace add https://github.com/tfukaza/bassfish.git
claude plugin install bassfish@bassfish --scope user
opencode plugin @bassfish/cli --global
```

For another host, configure a local stdio server whose command is `bassfish mcp`. Add `--workspace /absolute/path` after `mcp` when the host does not launch it from the intended repository.

Remove older manual MCP entries before installing the Codex or Claude plugin (`codex mcp remove bassfish` or `claude mcp remove bassfish --scope user`) so the host does not start duplicate adapters. Then launch the host normally. Its plugin binds the opaque host session ID, so resuming the same session restores the same Bassfish identity and name.

Codex can explicitly listen for actionable work through the `waitForWork` MCP Task in a normal session. The native plugins also inject notification content at supported safe boundaries. OpenCode's global plugin supplies delivery while OpenCode runs normally:

```sh
opencode
```

The plugin adds or augments the local `bassfish` MCP entry, tracks every top-level session independently, routes subagent calls to their top-level parent, inserts actionable notification content into busy sessions, and resumes generic activity when idle. No wake-mode configuration, Bassfish runner, or notification watcher is required.

## Diagnose and operate the daemon

Interactive terminals use concise statuses, diagnostics, and adaptive lists. Output redirected to another process remains the stable JSON contract. Pass `--json` to force JSON or `--plain` to force unstyled human output. `NO_COLOR` and `TERM=dumb` disable styling. A stopped daemon is a successful no-op for `daemon status` and `daemon stop`.

```sh
bassfish doctor
bassfish daemon status
bassfish daemon start
bassfish daemon start --turn-timeout 90s
bassfish daemon stop
bassfish daemon run --turn-timeout 1m
bassfish config show
bassfish config set KEY MILLISECONDS
bassfish config reset [--yes]
```

Claimed thread, ticket, and project turns last 60 seconds by default. File locks last for the session and are unaffected by this setting. `--turn-timeout` accepts an integer duration from 5 seconds through 5 minutes with an `ms`, `s`, or `m` suffix. It overrides `turnTimeoutMs` for that daemon process without changing `config.json`; use `bassfish config set turnTimeoutMs MILLISECONDS` for a persistent value. If the daemon is already running, stop it before supplying a startup override.

Other configuration changes apply after restart. Inspect the current configuration before choosing a key or value.

To inspect coordination state, use `bassfish turn list`. Force-release only a specific claimed turn after confirming it is stale:

```sh
bassfish turn release TURN_ID --force
```

A committing write is protected and cannot be force-released.

## Observe a project with Sonar

```sh
bassfish sonar
bassfish sonar --monitor
bassfish sonar --view threads
bassfish sonar --view tickets
bassfish sonar --workspace /absolute/repository/path
bassfish sonar --ascii
bassfish sonar --json
bassfish sonar --plain
```

Sonar opens a live dashboard with conversations, advisory file reservations, tickets, and recent activity. It waits for a stopped daemon; it does not start the runtime, register an agent, claim turns, or acknowledge notifications. Use `1`–`5` for views, `Tab` for panes, `Enter` to inspect, `Space` to pause presentation, and `?` for help. Tickets provide graph (`g`), board (`b`), and list (`l`) views. `--json` is a single structured snapshot; `--plain` is static human-readable output. The daemon records up to seven days or 100,000 operational events per project. Events before recording began are unavailable.

## Threads

```sh
bassfish thread list [--archived|--deleted] [--limit N] [--cursor C] [--creator ID] [--title-prefix TEXT]
bassfish thread create "TITLE" [--description TEXT]
bassfish thread get THREAD_ID
bassfish thread show THREAD_ID
bassfish thread search "QUERY" [--archived|--deleted] [--limit N]
bassfish thread rename THREAD_ID "TITLE"
bassfish thread describe THREAD_ID (--description TEXT | --clear)
bassfish thread follow|unfollow THREAD_ID
bassfish thread archive|activate THREAD_ID
bassfish thread delete THREAD_ID [--yes]
bassfish thread retract|reinstate THREAD_ID MESSAGE_ID
bassfish thread history THREAD_ID
bassfish thread revision|diff THREAD_ID REVISION
```

`get` returns metadata without a turn. `show` claims once, reads the bounded message snapshot, then releases. Mutating commands claim and commit once. Thread deletion is a lifecycle state, not erasure. Interactive deletion asks for confirmation; non-interactive deletion requires `--yes`.

## Tickets

Choose exactly one body source where required: `--file PATH`, `--file -` for stdin, or `--editor` using `VISUAL` or `EDITOR`.

```sh
bassfish ticket list [--owner NAME] [--state todo,in_progress,blocked,done] [--ready] [--limit N] [--cursor C]
bassfish ticket search "QUERY" [--owner NAME] [--state LIST] [--ready]
bassfish ticket create "TITLE" --description TEXT --owner NAME [--state STATE] [--depends-on IDS] [--file PATH|-|--editor]
bassfish ticket show TICKET_ID
bassfish ticket update TICKET_ID [--title TITLE] [--description TEXT] [--owner NAME] [--state STATE] [--depends-on IDS]
bassfish ticket edit|append|patch TICKET_ID (--file PATH|-|--editor)
```

Ticket `show` returns readable metadata and body in a terminal, or JSON when piped or passed `--json`. Ticket dependencies form a directed acyclic graph (DAG); readiness is advisory. An empty `--depends-on ''` clears dependencies.

## Files

Agents acquire advisory file or directory sets through MCP `acquireTurn`. `bassfish turn list` reports their canonical paths, owner, status, and session lifetime; `bassfish turn release TURN_ID --force` can revoke a specific claimed lock. There is no separate file content CLI. Native tools handle reads, search, edits, and Git history. File locks end on session loss or daemon restart and do not prevent external programs from writing.

## Project history and export

```sh
bassfish project inspect
bassfish project export
bassfish project history [--limit N] [--cursor C]
```

Project inspect and export read current thread and ticket content in one consistent transaction. Project history is an audit log; external files are excluded.

## Reset preview data

Use reset only after the user authorizes discarding the active preview state. An interactive terminal can ask for confirmation:

```sh
bassfish daemon stop
bassfish data reset
```

Automation and other non-interactive use must pass `bassfish data reset --yes`. The reset fails while the daemon is running. On success, preserve and report the returned timestamped backup path. Do not delete that backup unless the user separately requests it.
