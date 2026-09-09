# v0 release qualification

Bassfish has no backward-compatibility or migration gate in v0. A schema or API change is validated only against a fresh data directory.

## Automated gate

Run on both a current macOS runner and a current Ubuntu runner:

```sh
npm ci
npm run setup:dolt
npm run release:check
npm run test:soak
```

`test:soak` uses real SQLite and Dolt for 30 minutes by default. A short diagnostic run is `node scripts/soak.mjs --duration-ms=5000`; it is not release evidence.

The automated suites cover:

- turn ownership races, accepted-commit isolation, lost write replies without replay, and daemon or SQL guardian failure;
- whole-project restore, ticket dependency validation and readiness, and atomic file-set FIFO and cleanup;
- MCP presence, durable host-session names, direct/`@here`/`@global` fan-out, offline inbox catch-up, cancellable mention Tasks, content-bearing native delivery, and host-process isolation;
- the CLI editor flow and concurrent stdio MCP clients;
- thread history, diff, and restore; ticket editing; and project history, restore, and export.

The suites also fix the public MCP inventory at 13 tools, cap serialized tool descriptors at 14 KiB, reject private control and storage fields at the MCP boundary, and require empty `content` beside structured results.

## Host matrix

The supported matrix and pinned release-candidate versions are listed in [compatibility.md](compatibility.md). Install all three, install `@bassfish/cli`, and configure the `bassfish mcp` stdio command as shown in the README, then run:

```sh
npm run test:hosts
node scripts/host-smoke.mjs --live
```

The default command verifies that each executable and its MCP command launch. `--live` makes one real model invocation per host and requires each host to call `getContext`; it therefore needs the operator's configured accounts and may incur usage. Record the exact versions printed by the script with the release evidence. Missing hosts fail unless `--allow-missing` is explicitly used for local development.

For Codex, install `bassfish@bassfish`, rename the agent, exit, resume the same Codex session, and verify the name is restored. Start a different Codex session and verify it receives a different identity. Then ask the first session to listen for Bassfish work, send a direct mention or owned-ticket event from a second identity, verify the same active turn processes and acknowledges it, and verify cancellation leaves later notifications unread. Confirm a completed or closed Codex turn is never described as wakeable.

For native-delivery qualification, install `bassfish@bassfish` at Claude and Codex user scope and `@bassfish/cli` at OpenCode global plugin scope, then launch each host normally. Send direct, `@here`, `@global`, generic thread-activity, assignment, and newly-ready-ticket events from a second identity. Verify actionable content arrives at the next supported tool boundary, generic activity arrives only at idle, delivery leaves notifications unread, and resuming the same session redelivers unread items under the same identity. Confirm logs contain no turn credentials. For OpenCode, run two simultaneous top-level sessions, verify each receives only its own content, verify busy delivery uses a synthetic no-reply prompt without aborting, and verify subagent calls route to their top-level parent. For Codex, verify post-idle activity remains pending until the next prompt or explicit `waitForWork`.

## Disruptive OS gate

Perform these only on disposable macOS and Linux test machines or VMs, never on a development data directory:

1. Start a sustained writer against a dedicated `BASSFISH_DATA_DIR`; cut VM power during repeated commits. Restart and verify every pending operation resolves as committed, absent, or remains fail-closed as unknown, with no replayed operation ID.
2. Put the dedicated data directory on a size-limited volume. Fill it during SQLite control updates and during Dolt commits. Verify the operation fails, SQLite remains transactionally readable, and Dolt either resolves the operation or holds the project in recovery.
3. Suspend the OS for longer than the offer and lease windows. Resume and verify READY, OFFERED, and CLAIMED reservations expire before any protected read or write; COMMITTING is allowed to resolve.
4. Run the automated guardian-death integration case, then repeat while the VM is under I/O load. Verify the in-flight query aborts and the old SQL socket accepts no connection.

For every row record OS/build, architecture, Node version, Dolt version, host version, commit, start/end timestamps, and pass/fail evidence. A release is not qualified by this document alone; it requires fresh results for all six host/OS rows and all four disruptive cases on both operating systems.
