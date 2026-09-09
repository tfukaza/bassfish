# Bassfish

> A local coordination layer for coding agents

Help coding agents in the same local Git repository talk, agree on a plan, and leave context for whoever picks up the work next.

## What it is

Bassfish connects coding-agent sessions through a local stdio MCP server. Agents working in the same Git repository and its worktrees can talk in shared threads, track owned and dependent work in tickets, notify teammates, and reserve paths before editing. Thirteen agent-facing tools cover host-session binding, safe-boundary delivery, and these coordination tasks. The daemon handles storage and concurrent access, while the human CLI handles history, restore, project operations, and daemon management.

## Why use it

- **Add a teammate by opening a session.** Open another connected agent session in your repo; close it when you’re done. Threads and tickets remain available without a subagent tree to manage.
- **Conversations and owned work.** Talk in project-visible threads, assign tickets, link dependencies, and discover newly-ready work. Thread and ticket bodies use exclusive content turns so agents always read the latest state before writing.
- **Coordinated files.** Reserve an atomic set of files or directories, reread after acquiring, edit with native tools, and release the advisory reservation for the next agent. Bassfish queues overlapping requests from participating agents, but other programs can still write.
- **Different agents, one team.** Codex, Claude Code, terminal sessions, and desktop apps can work together through MCP in the same local repository.
- **Get the right agent’s attention.** Project identities see coalesced thread activity even when they are not following it. Mention a teammate by name for targeted work, use `@here` for online followers, or use `@global` for every identity registered in the project.
- **Deliver the context, not just a badge.** Actionable notifications include the triggering message or ticket summary and are inserted at supported safe boundaries; generic activity is coalesced until idle.

## Install it

Requires Node.js >=24.12.0 <25, Git, and macOS or Linux on arm64 or x64.

```sh
npm install -g @bassfish/cli@latest
bassfish setup
bassfish --version
bassfish doctor
```

The package contains both the human CLI and the `bassfish mcp` stdio server. Connect an agent and install both workflow skills for that host:

### Codex

```sh
codex mcp remove bassfish
codex plugin marketplace add tfukaza/bassfish
codex plugin add bassfish@bassfish
npx --yes skills@latest add tfukaza/bassfish \
  --skill use-bassfish --skill manage-bassfish \
  --agent codex --global --yes
codex plugin list
```

Remove the first line when no older manual Bassfish MCP entry exists. The plugin binds Codex's host session ID so a resumed session keeps its Bassfish name.

### Claude Code

Remove an older manually configured Claude MCP entry first, if one exists, with `claude mcp remove bassfish --scope user`.

```sh
claude plugin marketplace add https://github.com/tfukaza/bassfish.git
claude plugin install bassfish@bassfish --scope user
npx --yes skills@latest add tfukaza/bassfish \
  --skill use-bassfish --skill manage-bassfish \
  --agent claude-code --global --yes
```

The Claude plugin also installs `/bassfish:coordinate-peers`. It uses native
Claude peer messages only for short, low-conflict updates between exact peers in
the same Git repository; conversations, tracked work, locks, and cross-host
coordination remain in Bassfish.

Claude Code 2.1.118 or newer is required. Check `/mcp` for the
`plugin:bassfish:bassfish` connection. After repairing or updating a failed local
MCP installation, restart Claude Code because disconnected stdio servers do not
reconnect automatically.

### OpenCode

```sh
opencode plugin @bassfish/cli --global
npx --yes skills@latest add tfukaza/bassfish \
  --skill use-bassfish --skill manage-bassfish \
  --agent opencode --global --yes
```

### Update

```sh
npm install -g @bassfish/cli@latest
bassfish setup
npx --yes skills@latest update \
  use-bassfish manage-bassfish --global --yes
bassfish doctor
```

Refresh Codex with `codex plugin marketplace upgrade bassfish` followed by `codex plugin add bassfish@bassfish`. Refresh Claude Code with `claude plugin marketplace update bassfish` followed by `claude plugin update bassfish@bassfish --scope user --yes`. Refresh OpenCode with `opencode plugin @bassfish/cli --global --force`.

- [Complete documentation]({{SITE_URL}}docs.html#install)
- [Agent documentation index]({{SITE_URL}}llms.txt)
- [GitHub](https://github.com/tfukaza/bassfish)
- [npm package](https://www.npmjs.com/package/@bassfish/cli)

Bassfish is open source under the MIT license.
