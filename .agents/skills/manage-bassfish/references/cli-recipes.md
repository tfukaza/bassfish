# Bassfish CLI recipes

## Install and connect

Bassfish requires Node.js `>=24.12.0 <25`, Git, and macOS or Linux on arm64 or x64.

```sh
npm install -g @bassfish/cli
bassfish setup
bassfish --version
bassfish doctor
```

`bassfish setup` installs the checksum-verified Dolt runtime. To use an existing exact-version Dolt installation, set `BASSFISH_DOLT_BIN` to its absolute executable path.

Configure an agent host to run the stdio MCP server:

```sh
codex mcp add bassfish -- bassfish mcp
claude mcp add --scope user bassfish -- bassfish mcp
```

For another host, configure a local stdio server whose command is `bassfish mcp`. Add `--workspace /absolute/path` after `mcp` when the host does not launch it from the intended repository.

## Diagnose and operate the daemon

```sh
bassfish doctor
bassfish daemon status
bassfish daemon start
bassfish daemon start --turn-timeout 90s
bassfish daemon stop
bassfish daemon run --turn-timeout 1m
bassfish config show
bassfish config set KEY MILLISECONDS
bassfish config reset
```

Claimed turns last 60 seconds by default. `--turn-timeout` accepts an integer duration from 5 seconds through 5 minutes with an `ms`, `s`, or `m` suffix. It overrides `turnTimeoutMs` for that daemon process without changing `config.json`; use `bassfish config set turnTimeoutMs MILLISECONDS` for a persistent value. If the daemon is already running, stop it before supplying a startup override.

Other configuration changes apply after restart. Inspect the current configuration before choosing a key or value.

To inspect coordination state, use `bassfish turn list`. Force-release only a specific claimed turn after confirming it is stale:

```sh
bassfish turn release TURN_ID --force
```

A committing write is protected and cannot be force-released.

## Threads

```sh
bassfish thread list [--archived|--deleted] [--limit N] [--cursor C] [--creator ID] [--title-prefix TEXT]
bassfish thread create "TITLE" [--description TEXT]
bassfish thread get THREAD_ID
bassfish thread show THREAD_ID
bassfish thread search "QUERY" [--archived|--deleted] [--limit N]
bassfish thread describe THREAD_ID (--description TEXT | --clear)
bassfish thread delete THREAD_ID
```

`get` returns metadata without a turn. `show` claims once, reads the bounded message snapshot, then releases. Mutating commands claim and commit once. Thread deletion is a lifecycle state, not erasure.

## Notes

Choose exactly one body source where required: `--file PATH`, `--file -` for stdin, or `--editor` using `VISUAL` or `EDITOR`.

```sh
bassfish note list [--archived|--deleted] [--path-prefix PREFIX] [--label LABEL] [--kind KIND]
bassfish note create PATH --title TITLE (--file PATH|-|--editor) [--labels A,B] [--kind KIND]
bassfish note show NOTE_ID [--json]
bassfish note edit|append|prepend|patch NOTE_ID (--file PATH|-|--editor)
bassfish note move NOTE_ID NEW_PATH
bassfish note metadata NOTE_ID [--title TITLE] [--labels A,B] [--kind KIND|--clear-kind]
bassfish note links NOTE_ID [--link note:ID|thread:ID|message:ID]...
bassfish note replace-text NOTE_ID --find TEXT [--replace TEXT] --expect N
bassfish note section NOTE_ID --heading A/B (--file PATH|-|--editor) [--occurrence N] [--create]
bassfish note archive|delete|activate NOTE_ID
bassfish note history NOTE_ID
bassfish note restore NOTE_ID REVISION --yes
```

Editor mode reads and releases before opening the editor, then claims again and rejects the write with `EDIT_CONFLICT` if the note changed. Restore creates a new revision rather than rewriting history.

## Reset preview data

Use reset only after the user authorizes discarding the active preview state:

```sh
bassfish daemon stop
bassfish data reset --yes
```

The reset fails while the daemon is running. On success, preserve and report the returned timestamped backup path. Do not delete that backup unless the user separately requests it.
