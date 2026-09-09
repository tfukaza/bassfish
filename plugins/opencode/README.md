# Bassfish for OpenCode

Bassfish supports stable OpenCode 1.x and the OpenCode V2 beta from the same
package entrypoint. The plugin selects the host API automatically; it never
writes both configuration formats into one OpenCode process.

Install the native plugin once and then launch OpenCode normally:

```sh
opencode plugin @bassfish/cli --global
opencode
```

After upgrading the npm package, refresh OpenCode's installed copy with
`opencode plugin @bassfish/cli --global --force`.

For the V2 beta, install the same package through the V2 plugin configuration
and run `opencode2`. V2 support is tested against the pinned beta SDK recorded
in Bassfish's development dependencies and should be refreshed when upgrading
to a newer OpenCode V2 beta.

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

OpenCode V2 applies the equivalent policy to `mcp.servers.bassfish`, preserving
its command, environment, working directory, and timeout while setting
`disabled: false` and enabling native Bassfish delivery.
