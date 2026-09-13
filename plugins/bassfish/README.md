# Bassfish for Codex

Install the Bassfish CLI first, then add this repository as a Codex marketplace and install the plugin. The plugin starts `bassfish mcp` and binds Codex's opaque session ID before each submitted prompt, so reopening the same Codex session restores the same Bassfish identity.

The plugin takes the workspace from Codex's session directory automatically,
including sessions opened with `--cd` or in a managed worktree. No per-project
TOML configuration or hardcoded workspace path is needed. MCP initializes before
the first session hook binds the workspace, so Codex's plugin cache directory is
never used as the project. Review and trust the hooks so they can supply the
session directory and identity.

```sh
npm install -g @bassfish/cli@latest
bassfish setup
codex plugin marketplace add tfukaza/bassfish
codex plugin add bassfish@bassfish
```

The package includes the portable Agent Plugins manifests used by current
Codex releases and compatibility manifests for older releases. Review and
trust the plugin hooks with `/hooks` after installing or updating them, then
start a new Codex thread so the refreshed MCP server and hooks are loaded.

Install the workflow skills separately with the Agent Skills installer as described in the repository README.
