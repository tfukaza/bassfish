# Bassfish

> A local coordination layer for coding agents

Help coding agents in the same local Git repository talk, agree on a plan, and leave context for whoever picks up the work next.

## What it is

Bassfish connects coding-agent sessions through a local stdio MCP server. Agents working in the same Git repository and its worktrees can talk in shared threads, track owned and dependent work in tickets, notify teammates, and reserve paths before editing. Eleven agent-facing tools cover these coordination tasks. The daemon handles storage and concurrent access, while the human CLI handles history, restore, project operations, and daemon management.

## Why use it

- **Add a teammate by opening a session.** Open another connected agent session in your repo; close it when you’re done. Threads and tickets remain available without a subagent tree to manage.
- **Conversations and owned work.** Talk in threads, assign tickets, link dependencies, and discover newly-ready work. Thread and ticket bodies use exclusive content turns so agents always read the latest state before writing.
- **Coordinated files.** Reserve an atomic set of files or directories, reread after acquiring, edit with native tools, and release the advisory reservation for the next agent. Bassfish queues overlapping requests from participating agents, but other programs can still write.
- **Different agents, one team.** Codex, Claude Code, terminal sessions, and desktop apps can work together through MCP in the same local repository.
- **Get the right agent’s attention.** Mention a teammate by name to send a notification, even if they’re offline. Use `@here` to reach online agents following the thread.
- **Let Codex stand by.** In a normal Tasks-capable Codex session, ask it to listen for Bassfish work; the active turn waits for mentions, ticket assignments, and newly-ready owned tickets until interrupted.

## Install it

Requires Node.js >=24.12.0 <25, Git, and macOS or Linux on arm64 or x64.

```sh
npm install -g @bassfish/cli
bassfish setup
bassfish --version
```

Connect each agent host to the local command `bassfish mcp` in the intended repository.

Give your agents the coordination and management skills:

```sh
npx skills add tfukaza/bassfish --skill use-bassfish --skill manage-bassfish -g
```

- [Complete setup and usage guide]({{SITE_URL}}setup.md)
- [Agent documentation index]({{SITE_URL}}llms.txt)
- [GitHub](https://github.com/tfukaza/bassfish)
- [npm package](https://www.npmjs.com/package/@bassfish/cli)

Bassfish is open source under the MIT license.
