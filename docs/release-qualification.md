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

The integration suite includes simultaneous ownership races, accepted-commit isolation, lost write replies with no replay, daemon SIGKILL recovery, SQL guardian death during an in-flight query, exact whole-project restore, historical note search, CLI editor flow, and two concurrent stdio MCP clients.

## Host matrix

The supported matrix and pinned release-candidate versions are listed in [compatibility.md](compatibility.md). Install all three, configure this checkout's stdio command as shown in the README, then run:

```sh
npm run test:hosts
node scripts/host-smoke.mjs --live
```

The default command verifies that each executable and its MCP command launch. `--live` makes one real model invocation per host and requires each host to call `getSession`; it therefore needs the operator's configured accounts and may incur usage. Record the exact versions printed by the script with the release evidence. Missing hosts fail unless `--allow-missing` is explicitly used for local development.

## Disruptive OS gate

Perform these only on disposable macOS and Linux test machines or VMs, never on a development data directory:

1. Start a sustained writer against a dedicated `BASSFISH_DATA_DIR`; cut VM power during repeated commits. Restart and verify every pending operation resolves as committed, absent, or remains fail-closed as unknown, with no replayed operation ID.
2. Put the dedicated data directory on a size-limited volume. Fill it during SQLite control updates and during Dolt commits. Verify the operation fails, SQLite remains transactionally readable, and Dolt either resolves the operation or holds the project in recovery.
3. Suspend the OS for longer than the offer and lease windows. Resume and verify READY, OFFERED, and HELD reservations expire before any protected read or write; COMMITTING is allowed to resolve.
4. Run the automated guardian-death integration case, then repeat while the VM is under I/O load. Verify the in-flight query aborts and the old SQL socket accepts no connection.

For every row record OS/build, architecture, Node version, Dolt version, host version, commit, start/end timestamps, and pass/fail evidence. A release is not qualified by this document alone; it requires fresh results for all six host/OS rows and all four disruptive cases on both operating systems.
