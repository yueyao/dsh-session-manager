# dsh-session-manager

Batch browse, archive, delete and restore your DSH history sessions from a
sidebar panel.

DSH stores every history session on disk under
`DSH_HOME/sessions/<cwd-encoded>/<session-id>/` as a `session.v4.jsonl.zstd`
append-only event log, but the built-in session service exposes no delete or
archive API. This plugin fills that gap with a filesystem-level, reversible
workflow.

## Features

- **Enumerate** every history session across all working directories, with
  working-directory, last-updated time and on-disk size.
- **Multi-select** sessions in the sidebar panel and batch-operate.
- **Archive** — move sessions out of the active list into a global
  `DSH_HOME/archive/sessions/` directory. Data is preserved verbatim and can be
  restored any time.
- **Delete** — permanently remove sessions (`rm -rf`). Marked *irreversible*
  in the UI and confirmed before running.
- **Restore** — bring archived sessions back to their original working
  directory.

## Install

Install the plugin through the DSH plugin manager (Discover → Index sources),
or place the package in the profile's `node_modules`.

## Usage

1. Open the **会话管理 / Sessions** entry in the sidebar.
2. Tick the sessions you want (or use *全选 / Select all*).
3. Choose *归档 / Archive*, *删除 / Delete* (or *恢复 / Restore* in the
   Archived tab).

## Agent tools

The host half also registers four tools for the agent to use directly:

- `session_manager_list` — list all sessions and the archive.
- `session_manager_archive` — archive a batch by `ids`.
- `session_manager_restore` — restore a batch by `ids`.
- `session_manager_delete` — permanently delete a batch by `ids`.

## Layout

```
DSH_HOME/sessions/<cwd>/<id>/session.v4.jsonl.zstd   # active sessions
DSH_HOME/archive/sessions/<cwd>/<id>/...              # archived (preserved)
DSH_HOME/archive/sessions-index.json                  # archive index
```

## License

MIT
