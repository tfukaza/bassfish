# Bassfish Sonar

`bassfish sonar` opens a live, read-only project monitor. Run it from the Git repository being used by your agents, or pass `--workspace PATH`. Linked worktrees share project content; file reservations identify the physical workspace paths involved.

```sh
bassfish sonar
bassfish sonar --monitor
bassfish sonar --view threads
bassfish sonar --view tickets
bassfish sonar --workspace /absolute/repository/path
```

Sonar waits when the daemon is stopped. Start it separately with `bassfish daemon start`; Sonar attaches automatically. A connected monitor keeps the runtime available, but an explicit daemon stop still works. Older running daemons need an upgrade and restart to support the observer protocol.

## Views

- **Monitor:** conversations, file reservations, tickets, agents, and recent events together. Wider windows include an activity chart and compact dependency relationships.
- **Threads:** a channel sidebar and Markdown conversation reader with authors, timestamps, code blocks, mentions, and local unread markers.
- **Files:** a collapsible reservation tree and details showing exact paths, owners, workspace, held/waiting duration, and blocking reservations or earlier overlapping requests. `◆ LOCKED` marks an exact held target and `◇ REQUEST` marks an exact queued target; dim unmarked directories only group paths. Cross-project blockers are included when relevant.
- **Tickets:** dependency graph, state board, and sortable list. Arrows run from prerequisite to dependent. The inspector distinguishes a ticket marked `blocked` from unfinished dependencies.
- **Activity:** retained project events, including activity that occurred while Sonar was closed.

The graph loads connected ticket components, bounded to 200 nodes. Larger components use a focused neighborhood with explicit hidden-neighbor counts. Select a boundary ticket and focus it to explore further; the component picker can open another ticket's graph.

## Keys

| Key | Action |
| --- | --- |
| `1`–`5` | Monitor, Threads, Files, Tickets, Activity |
| `Tab`, `Shift+Tab` | Change focused pane |
| Arrows or `j` / `k` | Select rows; scroll detail panes |
| `Enter`, `Esc` | Inspect a selection; return |
| `Space` | Pause/resume presentation; collection continues |
| `/` | Filter; `Enter` applies, `Esc` clears |
| `m`, `?`, `q` | Monitor, help, quit |
| `g`, `b`, `l` in Tickets | Graph, board, list |
| `o` in Tickets | Sort loaded tickets by updated time, title, owner, or state |
| Shift+arrows in Graph | Pan the graph |
| `f`, `a`, `d` in Graph | Toggle focused neighborhood, choose component, navigate dependencies |
| `a` outside Graph | Inspect agents |
| `c` in Files | Collapse/expand a reservation set |
| `t` in Threads, `s` in Tickets | Cycle lifecycle/state filters |
| `p` | Older messages or activity |
| `n` | Next resource list, reservation paths/blockers, or ticket-body page |
| `End` | Return to current content and live following |
| Left/right in a detail pane | Scroll long code lines horizontally |

Activity filters accept `@Alice`, `type:files`, or `resource:RESOURCE_ID`. Ordinary text filters the loaded page. Ticket discovery supports `@Owner`; thread names and participants can be filtered in the loaded sidebar.

Scrolling up in a conversation pins the reading snapshot. New messages get an indicator rather than moving your position. Paged content is labeled as a pinned snapshot; `End` returns to live data. Reconnects preserve the display and clearly label stale data or gaps.

Press `Enter` on a file event in Activity to inspect a historical reservation, including after release. Path and blocker lists are paginated; blocker details show a representative overlapping path. The pause counter tracks journal updates across the local daemon, including other projects, while displayed events remain project-scoped.

## Terminal and automation

Use a terminal at least 80 columns by 24 rows. Larger windows show more content and a ticket inspector. Unicode box-drawing and labeled colors are the defaults. `--ascii` uses ASCII borders and connectors; `NO_COLOR` disables styling without removing keyboard navigation.

```sh
bassfish sonar --ascii
NO_COLOR=1 bassfish sonar
bassfish sonar --once
bassfish sonar --json
bassfish sonar --plain
```

`--once` prints a static overview. `--json` and redirected stdout produce one JSON snapshot; `--plain` and `TERM=dumb` produce static unstyled output. Resource lists are paginated with totals and continuation fields. A stopped daemon returns an explicit stopped status, not a fabricated empty project.

## What the observations mean

Sonar does not become an agent, acquire turns, follow threads, acknowledge notifications, send messages, or edit resources. Its unread markers belong only to the current window. Online means connected, not necessarily actively coding. The activity chart counts recorded events, not productivity or percentage completion.

File locks are advisory reservation sets: external editors can still write. They last for the owning session rather than the content-turn timeout. Sonar displays recorded requests and transitions, not native file contents or private host conversations.

Operational history is recorded by the daemon and retained for up to seven days or 100,000 events per project, whichever limit is reached first. Existing conversations and tickets are visible immediately, but events before recording began are not reconstructed. Sonar uses observer protocol 2 and pins paged reads to resource revisions. Legacy SQLite/Dolt data requires an archive and fresh initialization; unsupported Turso schemas are refused without rewriting them.

## Memory and crash diagnostics

Interactive Sonar defaults to React's production runtime when `NODE_ENV` is unset or empty. Explicit `development` and `test` settings remain available for debugging. React development performance records can accumulate in Node's timeline during long sessions; use `NODE_ENV=production bassfish sonar` when diagnosing an older installation. Increasing the heap limit does not fix that retention.

Sonar is a read-only client in a separate process from the database daemon. A Sonar crash does not establish that a content write failed or that storage was corrupted. For an uncertain write, inspect the resource and revision receipt before submitting another mutation.

`bassfish daemon status` and `bassfish doctor` show the daemon log location, including when it is stopped. The daemon records startup, readiness, graceful stop reasons, maintenance deferrals, and fatal errors under the data directory's `run/` directory. Background stderr is preserved in `daemon.log`; rotation retains the current file and three previous files at an 8 MiB rotation threshold with owner-only permissions. A missing final lifecycle record means the exit cause is unknown; inspect stderr rather than treating the last `ready` record as evidence of a graceful stop.


## Investigating timeouts and expired sessions

Diagnostics are automatic. `bassfish doctor --json` and `bassfish daemon status --json` report `diagnostics.logPath`, `runtimeLogPath`, and `clientLogPath`. For a running daemon they also include a runtime summary and its age. The lightweight health probe does not read the coordination database. An older, already-running daemon must be restarted with the updated CLI before it can produce these records; update connected clients as well. Restarting releases their existing file reservations.

The data directory's `run/` directory contains three streams:

| Stream | Evidence |
| --- | --- |
| `daemon.log` | Startup, version/configuration in the runtime startup record, readiness, shutdown, maintenance deferrals, fatal errors, and background stderr. |
| `runtime.log` | Health summaries every 30 seconds, slow/failed requests and storage operations, unfinished operation phases, session expiry, main-loop stalls, clock/sampler gaps, and recovery. |
| `clients.log` | Client connection attempts, response deadlines, heartbeat failures, lost connections, and late replies. |

New diagnostic records use JSON Lines with `schemaVersion: 1`, UTC `at`, process-local `monoMs`, `pid`, and daemon `epoch` when known. Background stderr can also contain ordinary text. Use UTC timestamps to align processes; monotonic durations measure elapsed work within a process. Use `ipcRequestId` to join a client deadline to its daemon request and storage operations, and `operationId` to follow a storage phase. Session records identify the instance and include the heartbeat age and configured timeout. Token and host-session hashes allow correlation without recording raw authorization values. The token hash is the first 24 hexadecimal characters of SHA-256.

Typical patterns:

- `storage.slow` with a long `pool_wait`, or `operation.pending` in `pool_wait`, identifies an occupied connection pool. Pool sizes and queued counts accompany the phase.
- A healthy main heartbeat with pending `statement`, `transaction_begin`, `commit`, or `rollback` identifies the database phase that is waiting. Statement records include an ordinal and operation kind, never SQL or arguments. `storage.attempt_failed` identifies known conflicts, rollback confirmation, and commit failure; retry counts and backoff appear in the operation summary.
- `runtime.stall_started` means the main heartbeat has not advanced for more than two seconds while the diagnostic worker can still run. Its sampled host CPU/load/memory and process CPU/RSS help distinguish a busy main loop from a native wait. Main-thread heap, event-loop utilization, and GC measurements become stale during the stall; their ages are explicit. GC totals are cumulative accepted samples, not a measurement made by the worker during the stall.
- `runtime.sampler_gap` means the worker itself was delayed. `runtime.clock_changed` records changes between wall and monotonic time. Suspension, clock adjustments, and OS scheduling can overlap; these records deliberately retain an unknown cause rather than claiming a definitive diagnosis.
- `runtime.host_pressure` records high host CPU (90%), load above 1.5 times the CPU count, or less than 5% free memory. Free memory excludes other reclaimable-memory information and is supporting evidence, not proof of memory exhaustion. Swap and detailed OS scheduler data are not collected.
- `session.disconnected` differentiates heartbeat expiry, socket loss, explicit closure, daemon shutdown, and daemon restart. Heartbeat expiry records the last successful heartbeat age and affected reservation count. `reservation.expired` identifies each expired reservation by request ID and hashed token. Session/reservation transitions are logged after their transaction commits.
- `client.late_reply` means a reply arrived after that client's deadline; the original operation was not replayed. Continue inspecting resource revisions and receipts before deciding whether another write is necessary.

Each stream retains its current file and `.1` through `.3` rotations, with about 32 MiB per stream (96 MiB overall, plus bounded record overshoot). Files have owner-only permissions. Normal successful requests and SQL statements are not individually persisted. Repeated incidents are coalesced for one minute, with suppression counts and maximum durations; health summaries and stall recovery are preserved. A `logging.dropped` record or `droppedOperationStates` warns that a timeline is incomplete. Pending writer queues and worker operation state are bounded to 1,024 entries. Transient phase updates are coalesced under load, with `coalescedOperationUpdates` and `deferredOperationStates` indicating sampling; incident messages have a reserved budget so successful SQL traffic does not consume their queue. Logging is best effort: a disk error, lock contention, or diagnostic worker failure never changes a Bassfish operation's result.

Collect all three streams and their rotations soon after an incident, together with `doctor --json` and `sonar --json`. Do not treat a missing record as evidence that an operation did not run or a write did not commit. Structured diagnostics omit content, SQL, and raw native error messages (which can contain parameters); fatal records preserve categories, message hashes, and stack-frame locations. Inherited stderr can contain ordinary dependency output. Resource IDs and operational timing may still be private project metadata.
