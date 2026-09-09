# Bassfish for OpenCode

Install the native plugin once and then launch OpenCode normally:

```sh
opencode plugin @bassfish/cli --global
opencode
```

After upgrading the npm package, refresh OpenCode's installed copy with
`opencode plugin @bassfish/cli --global --force`.

The package entry point registers the Bassfish MCP server automatically. It
connects directly to the local Bassfish daemon and keeps independent identity,
MCP routing, and delivery state for every active top-level OpenCode session.
Subagent calls route to their top-level parent. Direct mentions, `@here`,
`@global`, ticket assignments, and newly-ready tickets are inserted with their
content at the next safe boundary while the session is busy. Generic project
activity is coalesced and resumes the session when idle. The plugin never aborts a
busy session, and there are no delivery modes or hourly caps. No Bassfish wrapper
command or notification watcher is required.

If an `mcp.bassfish` local entry already exists, the plugin preserves its command,
working directory, timeout, and unrelated environment settings while adding the
native delivery marker. A remote or non-Bassfish entry with that reserved name is
rejected instead of overwritten.
