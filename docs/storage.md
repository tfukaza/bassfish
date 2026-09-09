# Local storage and the 0.5 upgrade

Bassfish 0.5 stores coordination, current content, immutable resource revisions, notifications, and activity in one local `bassfish.db`. The daemon owns eight embedded Turso 0.7.2 connections, configured with MVCC concurrent transactions, foreign keys, and full synchronous durability. There is no database server, TCP listener, cloud account, or sync dependency. The only SQLite files are empty process-ownership locks.

Each mutation commits its content, revision receipt, notifications, and turn/task completion in one transaction. Independent resource writes can overlap. Conflicting transactions retry only after confirmed rollback, up to five attempts. An uncertain commit is never automatically replayed: inspect the current resource and history before deciding whether another mutation is needed. Ticket graph edits serialize per project; file reservations validate overlaps with a shared transactional guard. Turn fencing remains authoritative after a restart.

Activity writes enter a durable outbox in the content transaction. A single publisher assigns public cursors after commit, so transactions that finish out of order cannot hide earlier events behind an observer cursor. Publication can resume after restart. Activity retains seven days and at most 100,000 events per project.

## Upgrade from the preview

1. Stop connected agent hosts and the old daemon (`bassfish daemon stop`). Do this with the old package before upgrading. No old host should restart its cached adapter during the cutover.
2. Install the new package and run `bassfish data reset --yes`. It refuses active daemon or legacy SQL-worker ownership, archives the entire data directory to a unique timestamped sibling, and copies only validated runtime settings into the fresh directory. Invalid settings stop the archive so you can correct them first.
3. Run `bassfish setup` and `bassfish doctor`. The new database is empty. Restart hosts using the new plugin/package, then create fresh shared content.
4. Keep the archive until you have verified the upgrade. Old projects, identities, notifications, and content remain there. There is no importer or in-place conversion.

Startup detects `control.sqlite`, `projects/`, `dolt-config/`, and older `dolt/` layouts and returns `RESET_REQUIRED` without opening them. Unsupported Turso schema versions are also refused without rewriting them. Never copy an old control file into a fresh Turso data directory.

To return to the preview, stop all hosts and the new daemon, archive the new directory, restore the untouched old directory at its original path, and use the matching old package. No new Turso content is merged into the old database.

## History and export

`bassfish thread history ID`, `revision ID REVISION`, and `diff ID REVISION` read immutable thread metadata and message visibility. The same commands under `bassfish ticket` inspect ticket metadata and body revisions. These reads do not acquire or consume turns. Ticket revisions describe the ticket at that time; they do not reconstruct the whole historical dependency graph.

`bassfish project inspect` and `bassfish project export` read current content in one consistent transaction. Export format 3 records each resource's revision and the export time. `bassfish project history` is an audit log. Project-wide historical snapshots and all restore commands have been removed. External files remain under their own version control and are excluded from exports.

## Native platforms

The pinned package supports Apple Silicon macOS and glibc Linux arm64/x64. Intel macOS, Windows, and musl Linux are unsupported. Node must be `>=24.12.0 <25`. CI covers each supported native target; third-party host qualification remains a separate release check.
