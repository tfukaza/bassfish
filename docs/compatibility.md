# v0 compatibility matrix

Bassfish 0.5 uses daemon API 14, observer protocol 2, and Turso schema 1. Legacy SQLite/Dolt data is rejected without modification. Archive it and initialize fresh storage as described in [storage.md](storage.md). Restart all hosts after upgrading. Resource history is read-only and requires no turn; project-wide historical snapshots and restore commands have been removed.

Target host versions for the 2026-09-08 v0 qualification are Codex `0.153.4`, Claude Code `2.1.265`, and OpenCode `1.18.29`. Bassfish itself requires Node `>=24.12.0 <25` and embedded Turso `0.7.2`. Supported native targets are Apple Silicon macOS and glibc Linux arm64/x64.

| Host | macOS | Linux |
| --- | --- | --- |
| Codex 0.153.4 | qualification required | qualification required |
| Claude Code 2.1.265 | qualification required | qualification required |
| OpenCode 1.18.29 | qualification required | qualification required |

“Qualification required” is deliberate: implementation tests are not a claim that a third-party host/version/OS row passed. Replace it with a dated `pass` only after both the launch inventory and `--live` smoke in [release-qualification.md](release-qualification.md) succeed on that operating system.

The MCP Tasks extension is optional. A host that does not negotiate `io.modelcontextprotocol/tasks` uses bounded `acquireTurn` calls and resumes a durable queued request with the returned `requestToken`; `cancelTurn` and `getContext.pendingTurns` provide cancellation and recovery. Such a host can use the other MCP tools but cannot call `waitForWork` for explicit targeted-work listening. A Tasks-capable host must accept either the ordinary `CallToolResult` or a `CreateTaskResult` on each eligible `tools/call`, as required by the extension. Codex qualification includes starting `waitForWork`, receiving a direct mention or owned-ticket event in the same active turn, and cancelling the listener without acknowledging unread work.

Native host-session identity is available through the Codex and Claude repository plugins and the globally installed OpenCode plugin. Codex and Claude pass their opaque session ID through hooks; OpenCode routes every Bassfish MCP call to its top-level session. Claude Code 2.1.232 or newer is the tested baseline for the current MCP runtime and tool hook. Supported hosts inject actionable notification content at safe boundaries. Claude Code and OpenCode can resume generic activity after idle; Codex retains post-idle notifications until the next prompt or an explicit `waitForWork`.

The pinned `@modelcontextprotocol/client` 2.0.0 test client can negotiate the 2026 envelope but does not register this external extension's `resultType: "task"` or `tasks/get` method. The transport suite confirms Bassfish emits the task result, while the stdio integration suite verifies the non-Tasks ticket path. This SDK limitation must not be interpreted as host support; only the per-host live rows above establish that.
