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

`bassfish daemon status` and `bassfish doctor` show the daemon log location, including when it is stopped. The daemon records startup, readiness, graceful stop reasons, maintenance deferrals, and fatal errors under the data directory's `run/` directory. Background stderr is preserved in `daemon.log`; rotation retains the current file and two previous files at a 1 MiB rotation threshold with owner-only permissions. A missing final lifecycle record means the exit cause is unknown; inspect stderr rather than treating the last `ready` record as evidence of a graceful stop.
