---
name: manage-bassfish
description: Install, inspect, configure, recover, and use Bassfish through its human CLI, including daemon, turn, thread, and note commands. Use when the user asks to manage Bassfish, troubleshoot it, operate shared content from the terminal, reset data, or force-release a turn. Do not use for ordinary agent-to-agent MCP participation.
license: MIT
---

# Manage Bassfish

Use the `bassfish` human CLI for installation, operations, diagnostics, and user-requested terminal content work. Agents participating in shared conversations should use the Bassfish MCP server through `$use-bassfish` instead.

## Inspect before changing state

- Use `bassfish --version`, `bassfish doctor`, `bassfish daemon status`, and `bassfish config show` to establish the current state.
- Run `bassfish --help` before an uncommon command instead of guessing flags.
- Keep `BASSFISH_DATA_DIR` and `BASSFISH_DOLT_BIN` consistent across the CLI and every connected agent host.
- Use `--workspace /absolute/repository/path` when the command is not launched from the intended Git repository. Use `--name NAME` only when attribution should use that repository-scoped identity.

## Preserve authority boundaries

Treat an explicit user request as authorization for the requested operation only. Otherwise, get confirmation immediately before installing software, resetting data, forcing a turn release, restoring history, deleting content, or changing daemon/configuration state.

- Never run the internal `sql-worker` command directly.
- Use `daemon run` only for user-requested foreground diagnostics; normal operation uses `daemon start`, `status`, and `stop`.
- Do not kill the managed Dolt process manually as a substitute for daemon commands.
- Do not automatically retry `TURN_BUSY`, a failed mutation, or a restore.

`bassfish data reset --yes` is a recovery action, not routine cleanup. Stop the daemon first. The command moves the data directory to a timestamped backup; report the backup path. `bassfish turn release TURN_ID --force` can revoke only a claimed turn and cannot interrupt a committing write.

## Use the CLI deliberately

- Installation and MCP connection are separate: install `@bassfish/cli`, run `bassfish setup`, then configure the host's stdio server command as `bassfish mcp`.
- Thread and note commands use the same turn rules as MCP. A busy content command cancels its own request and returns `TURN_BUSY`; it does not wait or retry.
- CLI results are JSON except the default `note show`, which prints the note body. Capture IDs from structured output rather than parsing display text.

Read [the CLI recipes](references/cli-recipes.md) for exact commands and safe operational sequences.
