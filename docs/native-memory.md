# Native memory protection

Bassfish uses the verified `0.7.2-bassfish.1` native binding and pins `@tursodatabase/database-common` to 0.7.2. The two protections are independent: the native registry prunes expired weak handles every 256 prepares, and Bassfish retires each pooled connection after 4,096 successful prepares. Every one-shot statement closes in `finally`, including execution failures. Cleanup failures preserve an existing execution error.

Prepare counts include nested operations and attempts that roll back. Retirement happens only after the complete transaction finishes, including commit/rollback and publication. A transaction may exceed the threshold. Replacements open and configure before closing the retired connection, run one at a time, and allow at most one additional connection. FIFO acquisition waiting and the existing five-attempt conflict policy remain intact.

A completed write returns and publishes independently of replacement work. Replacement open/configuration/close failure quarantines the slot, rejects pending acquisitions with `STORAGE_UNAVAILABLE`, stops acquisition, and drains the store. It never replays a mutation or turns a committed result into a replacement error. Shutdown waits for active leases and replacements, then attempts to close every remaining connection, including partially configured replacements. Uncertain commit/rollback outcomes retain the existing `OUTCOME_UNKNOWN` behavior.

The threshold bounds connection bookkeeping by usage plus the size of an active transaction. It is not a hard bound on total process memory: the engine, JS heap, workload and result sizes also consume memory.

## Diagnostics

`bassfish doctor` reports the local binding identity, and daemon health adds binding identity, per-slot generation/prepare counts, native retained/live reference counts, current pool state, and replacement counts and last duration. The daemon's existing bounded diagnostic streams record replacement success/failure and operation phases. These fields contain no SQL, parameters, or stored content. CLI commands and the 13-tool MCP inventory are unchanged.

## Acceptance

```sh
npm run native:build
npm run build
npm run ci
npm run test:memory
npm run test:memory-soak
npm run package:check:host
npm run test:hosts
```

The memory regression runs three isolated children: patched binding with recycling disabled, official binding with recycling enabled, and both protections enabled. Each executes 100,000 reads and 100,000 updates against fixed-size data, with explicit GC and yields. It requires bounded registry/prepare counts, multiple recycling cycles where enabled, the exact persisted value, physical memory below 512 MiB, final-window growth below 32 MiB for both reads and updates, and shutdown within 10 seconds. On macOS, physical footprint includes compressed/swapped accounting; Linux samples RSS plus swap.

The 30-minute isolated daemon soak exercises six agents, heartbeats, six native notification monitors, and Sonar. Native-memory mode disables scheduled restarts, uses a test-only daemon entry point with IPC GC checkpoints, checks daemon identity, session expiry and replacement failures, measures physical footprint, and requires a stable final memory window. It records retained JS heap and external memory alongside physical footprint. The fixed-dataset regression has the 512 MiB safety ceiling; the mixed daemon workload is qualified by its final memory trend. A short soak is diagnostic evidence only. Release qualification also requires all three installed-platform tarballs and the existing host qualification; a host-only package does not qualify a release.

See [the native build instructions](../native/turso/README.md) and [release qualification](release-qualification.md).

## Local qualification — September 13, 2026

On macOS arm64 with Node 24.12.0, the native-memory change atop `0e670f5f7c917dd6d5beddfbf4ae88f284df11f3` passed formatting, type checking, dead-code analysis, build, 135 unit tests, and 17 integration tests. The pinned Rust registry test and native live-handle tests passed. Each independent fixed-dataset protection passed; final-window growth was at most 48 KiB. See [the measured reproduction](../native/turso/reproduction.md).

The isolated daemon soak passed in 1,801,466 ms with 558 committed messages, 150 successful replacements, and 120 native notification deliveries. There were no unexpected restarts, replacement failures, or heartbeat-expired sessions. The final ten-minute physical-footprint window grew by at most 22.3 MiB across ten GC checkpoints, including macOS compressed/swapped accounting; the final retained daemon JS heap was 15.4 MiB. Persisted message count and shutdown within the 10-second deadline passed.

The installed host-only tarball passed and measured 6,780,465 compressed bytes. Host launch checks passed with Codex 0.154.0, Claude Code 2.1.269, and OpenCode 1.18.29. Linux native builds and installed tarballs, live host-model sessions, and disruptive OS qualification still require their own results. These checks did not publish, globally install, or activate a new CLI or daemon.

## Activation

No database migration or reset is required. Update the CLI, stop and restart the daemon, and restart client/host processes so they use the updated package. Run `bassfish doctor` and verify both `storage.bindingIdentity` and `daemon.storage.bindingIdentity` are `0.7.2-bassfish.1`. A local patched CLI can inspect an older running daemon; check the daemon identity separately.

Publication, global installation, and live activation are separate rollout steps.
