# cos-mcp

A stdio MCP server that lets a local agent (Claude Code, Codex) watch and control Chat On
Steroids from **outside** the app's process.

The agent is the watcher: it decides when to check and what to do. cos-mcp reports facts and
enforces a few safety limits. Because the agent launches cos-mcp itself, cos-mcp keeps working
when the app is hung or dead. It can still say what happened, show the app's log, and start the
app again.

This first version works with the app as it ships today. It uses no app-side API: only the
process list, the browser bridge's unauthenticated `/hello` route and the app's own `app.log`. The
app-side control API proposed in #82 / #482 will replace the log heuristics and add sending
messages, reading chats and changing settings.

## Setup

```bash
cd tools/cos-mcp
npm install
npm run build
```

Then register it with your agent. Use the absolute path to `dist/index.js`:

```bash
claude mcp add cos -- node /path/to/chat-on-steroids/tools/cos-mcp/dist/index.js
codex mcp add cos -- node /path/to/chat-on-steroids/tools/cos-mcp/dist/index.js
```

Add `--read-only` after the path to expose only the reading tools.

## Tools

| Tool | What it does |
| --- | --- |
| `cos_health` | State, summary, suggested action, issues, process metrics and recent log facts. |
| `cos_logs` | Reads `app.log` (and `app.log.1`), filtered by level, text and time. |
| `cos_journal` | Start/stop/restart actions taken through cos-mcp, with reasons and evidence folders. |
| `cos_start` | Starts the app in the background and waits up to 2 min for it to answer. |
| `cos_stop` | Kills the app. There is no graceful quit without the app-side API yet. |
| `cos_restart` | Re-checks a silent app for up to 45 s, saves evidence, kills it, starts it and waits for it. |

### States reported by `cos_health`

| State | Meaning | Suggested action |
| --- | --- | --- |
| `healthy` | Running and answering, nothing wrong. | none |
| `degraded` | Answering, but with issues: failed state writes, outdated extension, tunnel offline > 10 min, many unattributed calls, worker or recovery failures. A restart does not fix these. | investigate |
| `not_responding` | The main process exists but stopped answering after startup finished. | restart |
| `starting` | Started less than 2 min ago and not answering yet. | wait |
| `startup_hung` | Started more than 2 min ago and never answered. | restart |
| `updating` | An update hand-off was logged; the app restarts itself. | wait |
| `stopped_by_user` | Closed cleanly, or stopped through `cos_stop`. | none |
| `down` | Not running and did not close cleanly. | start |

## Safety limits

- Nothing is done while an update is being installed.
- An app the user closed is started again only when `userRequested: true`.
- An app that still answers is killed only when `force: true`.
- A silent app is re-checked for 45 s before it is killed. Evidence is saved first: the health
  report, the process list with memory, threads and handles, and the last 500 log lines.
- At most 3 automatic starts or restarts per hour. After that the agent must pass `force` or ask
  the user.
- One control action runs at a time across all agent sessions.
- Every control action is journaled with the agent's reason. On Windows, a toast reports forced
  restarts and failures.

## Files

cos-mcp only **reads** the app's userData. It writes to its own folder:
`%LOCALAPPDATA%\cos-mcp` on Windows, `~/Library/Application Support/cos-mcp` on macOS, and
`$XDG_STATE_HOME/cos-mcp` on Linux. That folder holds:

- `state.json`: last responsive time, last executable seen, recent actions;
- `journal.jsonl`: control actions;
- `incidents/<time>-<action>/`: evidence captured before a kill.

## Environment overrides

| Variable | Default (Windows) |
| --- | --- |
| `COS_USER_DATA` | `%APPDATA%\chat-on-steroids` |
| `COS_MCP_HOME` | `%LOCALAPPDATA%\cos-mcp` |
| `COS_BRIDGE_PORTS` (falls back to the app's `CLF_BRIDGE_PORTS`) | `8765-8769` |
| `COS_PROCESS_NAME` | `Chat On Steroids.exe` |
| `COS_EXE` | `%LOCALAPPDATA%\Programs\Chat On Steroids\Chat On Steroids.exe` |
| `COS_MCP_NO_TOAST=1` | toasts on |

## Limits of this version

- The log messages it reads are not an API; a release may reword them. Unrecognized text is
  treated as "not seen", never as a failure.
- Stopping and restarting are forced kills. That is safe for a hung app, which is not writing
  anyway, but it is why a working app is only killed with `force`.
- Windows is the tested platform. macOS and Linux process detection is best effort.

## Development

```bash
npm test          # builds, then runs the unit tests and a real stdio round trip
npm run typecheck # sources and tests
```

The tests never touch a real installation. They use a temporary userData, a closed port and a
process name that cannot exist.
