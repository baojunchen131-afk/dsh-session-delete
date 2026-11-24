# Session delete

Really delete a DeepSeek Harness session from the sidebar right-click menu — including the one that is currently open with a running agent.

## What it does

- Adds **Delete session** to the session context menu (right-click any session in the sidebar).
- Works for idle sessions and for the live session you are currently viewing.
- Moves the session directory into `<sessions-root>-trash/<timestamp>__<session-id>` instead of shredding it, so you can restore it by hand.
- Removes the sidebar row immediately without a full page reload (via the official `api-session/removed` broadcast).
- If the deleted session was the one on screen, the main view returns to the empty "no session" state.

## How it works (DSH 0.2.2-rc.5)

1. Stop the session's work the official way (`workspace/session-stop`: cancels the running turn, kills jobs, cancels subagents, stops schedules), then wait — bounded — for the agent to reach quiescence (`whenIdle`). This happens **outside** the workspace registry's operation chain to avoid deadlocking the agent's idle checkpoints.
2. Detach the runtime agent entry, dispose its scope, then detach the session entry. `session/disposed` makes the JSONL persistence flush and close its write handle, and makes the session controller broadcast `api-session/removed`.
3. Remove the session from workspace bookkeeping (and the archived/pinned sets), then move the directory into the trash with retries for briefly-held handles.

## Usage

1. Right-click a session in the sidebar.
2. Choose **Delete session**.
3. Confirm in the dialog. The row disappears and the directory is moved into `sessions-trash`.

## Restore

There is no undo in the UI. To restore a session, quit DSH and move its directory back from `sessions-trash` into `sessions/` (under the same project slug folder), then reopen DSH.

## Limitations

- Relies on DSH internal services (`sessions`, `agents`, `workspaceRegistry`, `sessionPersistence`), all feature-detected. A future DSH version that changes these internals may degrade the capability; check `GET /dsh-session-delete/diag` first after upgrading.
- The Host half registers HTTP routes in-process; after installing or replacing the plugin, reload the Host (disable/enable the plugin or restart DSH) and refresh the page so the browser half loads.
