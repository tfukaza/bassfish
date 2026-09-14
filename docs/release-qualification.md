# v0 release qualification

Bassfish v0 does not promise public API compatibility. The 0.6 schema-1-to-2 migration is transactional and preserves content and unread work; qualification covers both fresh storage and that migration.

## Automated gate

The native-build workflow first builds and merges patched binaries for macOS arm64 and glibc Linux arm64/x64. With those artifacts in `native/turso/artifacts`, run on all three matching runners:

```sh
npm ci
npm run build:release
npm run release:check
npm run test:memory
npm run test:memory-soak
npm run test:soak
```

`test:soak` uses embedded Turso for 30 minutes by default. A short diagnostic run is `node scripts/soak.mjs --duration-ms=5000`; it is not release evidence.

Release packaging requires all three verified binaries, their build metadata and hashes, and the upstream license. The compressed package limit is 64 MiB. `package:check` installs the complete tarball on each supported platform and verifies the patched identity without the official native dependency. `build` and `package:check:host` allow host-only development and do not qualify a release. See [native memory acceptance](native-memory.md) for isolated regressions, physical footprint measurement, and activation instructions.

The automated suites cover:

- turn ownership races, accepted-commit isolation, lost write replies without replay, and daemon failure;
- current-project export and resource history, ticket dependency validation and readiness, and atomic file-set FIFO and cleanup;
- MCP presence, durable host-session names, direct/`@here`/`@global` fan-out, offline inbox catch-up, cancellable mention Tasks, content-bearing native delivery, and host-process isolation;
- the CLI editor flow and concurrent stdio MCP clients;
- thread history and diff; ticket editing; and project history and export.

The suites also fix the public MCP inventory at 13 tools, cap serialized tool descriptors at 14 KiB, reject private control and storage fields at the MCP boundary, and require empty `content` beside structured results.

CI and publication also install Codex 0.154.0 and run `test:codex-queue` on all three native platforms. This installs the actual native plugin into private state, verifies an assigned ticket and direct mention reach the same idle TUI, checks coexistence with inline hooks and preserved permissions, and requires zero further model requests during 60 seconds of settled idle. It uses a fake local provider and does not qualify paid-provider host sessions.

## Host matrix

The supported matrix and pinned release-candidate versions are listed in [compatibility.md](compatibility.md). Install all three, install `@bassfish/cli`, and configure the `bassfish mcp` stdio command as shown in the README, then run:

```sh
npm run test:hosts
node scripts/host-smoke.mjs --live
```

The default command verifies that each executable and its MCP command launch. `--live` makes one real model invocation per host and requires each host to call `getUpdates`; it therefore needs the operator's configured accounts and may incur usage. Record the exact versions printed by the script with the release evidence. Missing hosts fail unless `--allow-missing` is explicitly used for local development.

For Codex CLI 0.154+, install `bassfish@bassfish`, rename the agent, exit, resume the same session, and verify the name is restored. Start a different session and verify it receives a different identity. Complete a normal turn, send an actionable update, and verify the queue wakes the same idle session without a standby prompt. Generic activity must leave it idle. Verify interruption pauses queueing until the next prompt and closing the TUI leaves later work unread. Explicit Tasks listeners remain an optional active-turn workflow.

For native-delivery qualification, install `bassfish@bassfish` at Claude and Codex user scope and `@bassfish/cli` at OpenCode global plugin scope, then launch each host normally. Send direct, `@here`, `@global`, generic thread-activity, assignment, and newly-ready-ticket events from a second identity. Verify actionable content arrives at the next supported tool boundary, Codex keeps generic activity for active checkpoints while Claude and OpenCode retain idle delivery, delivery leaves notifications unread, and resuming the same session permits replay of unhandled batch tokens under the same identity. Confirm logs contain no turn credentials. For OpenCode, run two simultaneous top-level sessions, verify each receives only its own content, verify busy delivery uses a synthetic no-reply prompt without aborting, and verify subagent calls route to their top-level parent. For Codex CLI 0.154+, verify actionable updates wake the same bound UUID after idle, generic activity stays pending for a checkpoint, and an accepted batch never creates recurring wakes. Verify uncertain queue outcomes retain unread work and are reported at the next checkpoint. Include a 60-second settled-idle fake-provider interval with zero generation requests.

## Disruptive OS gate

Perform these only on disposable macOS and Linux test machines or VMs, never on a development data directory:

1. Start a sustained writer against a dedicated `BASSFISH_DATA_DIR`; cut VM power during repeated commits. Restart and verify every pending operation resolves as committed, absent, or remains fail-closed as unknown, with no replayed operation ID.
2. Put the dedicated data directory on a size-limited volume. Fill it during Turso transactions. Verify no partial content, revision, notification, or turn completion becomes visible. Inspect the persisted operation receipt after any ambiguous commit; never automatically replay an uncertain mutation.
3. Suspend the OS for longer than the offer and lease windows. Resume and verify READY, OFFERED, and CLAIMED reservations expire before any protected read or write; COMMITTING is allowed to resolve.
4. Run the automated daemon-death integration case, then repeat while the VM is under I/O load. Verify clients reconnect to a new daemon epoch and uncertain mutations are inspected rather than replayed.

For every row record OS/build, architecture, Node version, Turso version, host version, commit, start/end timestamps, and pass/fail evidence. A release is not qualified by this document alone; it requires fresh results for all six host/OS rows and all four disruptive cases on both operating systems.

## Reliability qualification

Run `node --expose-gc --max-old-space-size=384 scripts/reliability-soak.mjs` for the 45-minute daemon/monitor/Sonar qualification. It creates a temporary repository and database, starts six native notification monitors and six synthetic agents, renders Sonar without retaining terminal frames, commits messages, and restarts the temporary daemon twice. It verifies committed message counts, native notification delivery, monitor survival, stable daemon identity between scheduled restarts, absence of React performance records, and a 128 MiB retained-heap ceiling for the Sonar harness. It never uses the installed daemon's data directory.

The integration suite also runs a 1,000-update Sonar memory regression in a fresh process, long startup-lock contention, cancellation, transient monitor failures, and permanent API mismatch. Existing crash-boundary storage tests verify atomic content, receipts, notifications, and turn state before, during, and after commit.

### Local evidence — September 8, 2026

On macOS arm64 with Node 24.12.0, the reliability run completed in 2,700,570 ms with 686 committed messages, 216 native notification deliveries, and two planned daemon restarts. All six monitors survived; Sonar's sampled retained heap stayed between 23 and 27 MiB. The final persisted thread sequence matched all 686 commits. Some notification polls exceeded their response deadline under concurrent load and recovered automatically; this run does not establish a latency guarantee.

CI passed formatting, type checking, dead-code analysis, build, 110 unit tests, and 14 integration tests. Package smoke and Codex, Claude Code, and OpenCode launch checks passed. These are local checkout results; Linux, live host-model sessions, and the disruptive OS gates require their own release qualification. No installed CLI, plugin, or live user daemon was updated.
