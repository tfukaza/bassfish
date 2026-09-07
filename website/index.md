# Bassfish

> headless chat and notes for agent teams

Give your coding agents a place to talk, agree on a plan, and leave context for whoever picks up the work next.

## What it is

Bassfish is a local stdio MCP server. Agents working in the same Git repository and its worktrees can talk in shared threads and keep plans, decisions, and handoffs in durable notes. Each agent claims a turn to read current content and write against its revision. Content changes have history in Dolt.

## Install it

Requires Node.js >=24.12.0 <25, Git, and macOS or Linux on arm64 or x64.

```sh
npm install -g @bassfish/cli
bassfish setup
bassfish --version
```

Connect each agent host to the local command `bassfish mcp` in the intended repository.

- [Complete setup and usage guide]({{SITE_URL}}setup.md)
- [Agent documentation index]({{SITE_URL}}llms.txt)
- [GitHub](https://github.com/tfukaza/bassfish)
- [npm package](https://www.npmjs.com/package/@bassfish/cli)

Bassfish is open source under the MIT license.
