# Bassfish for Claude Code

This plugin connects Claude Code to the Bassfish MCP server and starts the
optional Bassfish notification monitor. Install it at user scope, then start
Claude Code normally. The MCP adapter and Monitor bind to the same local Claude
session without wrapping the `claude` process.

```sh
claude plugin marketplace add https://github.com/tfukaza/bassfish.git
claude plugin install bassfish@bassfish --scope user
```

Remove an older manually configured `bassfish` MCP server before enabling the
plugin, or Claude will start two Bassfish adapters.

The prompt hook passes Claude's opaque `session_id` to Bassfish. Resuming the same
Claude session in the same repository restores the same identity and any name
chosen with `setAgentName`; that name does not become a default for new sessions.

Direct mentions, `@here`, `@global`, ticket assignments, and newly-ready tickets
are inserted with the triggering thread message or ticket summary at prompt and
post-tool safe boundaries. At Stop, pending work keeps the turn active. The
Monitor resumes a fully idle session for coalesced generic project activity.
Delivery does not acknowledge the notification, and there are no wake modes or
hourly caps.

Claude Code 2.1.118 or newer is required because earlier versions do not
support the MCP tool hook used to restore session identity. The monitor runs only in interactive CLI sessions and
may be unavailable on some hosted providers or when nonessential traffic is
disabled.

## Connection troubleshooting

Use `/mcp` inside Claude Code to inspect the plugin connection. Bassfish appears
as `plugin:bassfish:bassfish`; the prompt hook binds to that qualified server
name. If startup failed, update the global CLI, refresh the plugin, and restart
Claude Code:

```sh
npm install -g @bassfish/cli@latest
claude plugin marketplace update bassfish
claude plugin update bassfish@bassfish --scope user --yes
```

The plugin resolves the CLI through the user's shell on macOS and Linux, which
supports Node installations managed by tools such as nvm. Claude does not
automatically reconnect a disconnected local stdio server, and it may cache a
startup failure briefly, so restarting the session is required after repairing
the executable or updating the plugin.

## Coordinate Claude peers

The plugin also provides `/bassfish:coordinate-peers`. It teaches Claude when to
use Claude Code's native cross-session messaging and when to keep coordination in
Bassfish:

- Native peer messages are for short, low-conflict, loss-tolerant updates between
  exact recipients verified to be in the same Git repository.
- Bassfish remains the canonical lane for conversation, decisions, tickets,
  handoffs, direct conflict notices, file reservations, and non-Claude agents.
- Tracked work is recorded in Bassfish before an optional native summary links to
  its resource ID. A failed or ambiguous native send falls back to Bassfish once.

The skill respects Claude's existing peer-message privacy and approval settings;
it never changes them. `TURN_BUSY` does not trigger a native broadcast or bypass
the Bassfish turn flow.
