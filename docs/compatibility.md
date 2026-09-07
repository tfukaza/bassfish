# v0 compatibility matrix

Target host versions for the 2026-09-06 v0 qualification are Codex `0.153.4`, Claude Code `2.1.263`, and OpenCode `1.18.29`. Bassfish itself requires Node `>=24.12.0 <25` and Dolt `2.3.2`.

| Host | macOS | Linux |
| --- | --- | --- |
| Codex 0.153.4 | qualification required | qualification required |
| Claude Code 2.1.263 | qualification required | qualification required |
| OpenCode 1.18.29 | qualification required | qualification required |

“Qualification required” is deliberate: implementation tests are not a claim that a third-party host/version/OS row passed. Replace it with a dated `pass` only after both the launch inventory and `--live` smoke in [release-qualification.md](release-qualification.md) succeed on that operating system.

The MCP Tasks extension is optional. A host that does not negotiate `io.modelcontextprotocol/tasks` receives the ordinary durable ticket API and remains fully functional. A host that does negotiate it must accept either the ordinary `CallToolResult` or a `CreateTaskResult` on each eligible `tools/call`, as required by the extension.

The pinned `@modelcontextprotocol/client` 2.0.0 test client can negotiate the 2026 envelope but does not register this external extension's `resultType: "task"` or `tasks/get` method. The integration suite confirms Bassfish emits the task result, observes that client reject it as unsupported, and then verifies the required ticket fallback. This SDK limitation must not be interpreted as host support; only the per-host live rows above establish that.
