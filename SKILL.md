---
name: shared-browser-terminal
description: Share a persistent Mac terminal in a password-protected browser using tmux, ttyd, and a free Cloudflare Quick Tunnel. Use for "host my terminal", "browser terminal", "share this terminal", "remote-control my terminal", "the Cloudflare terminal", Warp-like terminal access from another laptop, or reconnecting, stopping, and styling that setup. Shares a terminal, not a desktop Codex conversation.
---

# Shared browser terminal

Share a persistent Mac shell through tmux, password-protected ttyd, and a free
Cloudflare Quick Tunnel. The skill is **shared-browser-terminal**. It lives in the
personal skills directory, outside project repositories.

## Start or reconnect: one command

After reading this skill, run the bundled helper directly. For Codex
`exec_command`, use **`login: false`**, **`workdir: /private/tmp`**, and request
**`sandbox_permissions: require_escalated`** through the normal tool mechanism.
This host operation needs macOS process inspection, tmux sockets, and network
access. A login shell can run unrelated profile commands that change Git config;
the sandbox can deny `ps` before the helper starts. Do not attempt a sandboxed
status command first. Respect actual tool approval decisions.

```bash
python3 ~/.codex/skills/shared-browser-terminal/scripts/browser_terminal.py open --cwd /absolute/project/path
```

For **"new remote terminal"** or **"new shell"**, add `--new-window` and a unique
request ID. Reuse that ID if this same request needs a retry:

```bash
python3 ~/.codex/skills/shared-browser-terminal/scripts/browser_terminal.py open --cwd /absolute/project/path --new-window --request-id REQUEST_ID
```

Use a short ID containing letters, digits, hyphens, or underscores. A fresh
session uses its first shell; an existing session gets a new window. The helper
selects that window for attached clients but preserves other shells and agents.
A repeated ID reuses its window instead of making duplicates.

**Do not precede normal startup with `status`, `verify`, source searches, log
reads, or manual tmux commands.** `open` handles exact session matching, saved
settings, dependencies, local authentication, tunnel reuse/repair, public
HTTP authentication, and WebSocket verification. Poll its running tool process
instead of launching a second copy. A healthy tunnel is reused immediately.

Read the JSON result:

- `readiness: ready` (exit 0): return `url`, `credentials_file`, and optionally
  `local_attach`. Checks passed: local/public anonymous 401, authenticated 200,
  public WebSocket 101. Include any `notice` about host DNS lag; a browser using
  that resolver may still need to wait. Do not claim that browser DNS was fixed.
- `readiness: pending` (exit 2): keep the shell/tunnel running. The command has
  retried temporary DNS/edge failures for its readiness budget (default 45s).
  Retry the same command and request ID once, optionally with `--wait 90`. If
  still pending, report the reason and read only the relevant troubleshooting
  section. Do not present a saved but unverified URL as working.
- Other failure: follow the specific error. Only install dependencies if missing.
  Authentication or certificate failures are fatal; do not weaken checks or
  repeatedly restart the tunnel to hide them.

No extra publication confirmation is needed when the user requested browser
access. The helper binds authenticated ttyd to `127.0.0.1:7682`, verifies local
authentication before publication, and manages only recorded processes. Never
publish an old unauthenticated listener such as port 7681.

## Defaults and boundaries

- Warp **Phenomenon** palette, **14px**, line height **1.0**, hidden tmux status
  bar, a steady cursor, trackpad/wheel scrolling, 50,000 lines of scrollback
  for new panes. The browser does not hide the caret while idle or during
  output; applications retain control of their own cursor visibility.
- Drag to highlight text; the highlight stays after release. **⌘C** copies on
  Mac (**Ctrl+Shift+C** elsewhere). **Ctrl+C** still interrupts commands.
- **Command-click** a visible HTTP/HTTPS URL to open it in a new browser tab.
  Ordinary clicks and drags retain text selection.
- **Shift+Enter** adds a newline in the Codex composer; Enter submits normally.
  The browser sends Codex's Alt+Enter alias through tmux. Other programs follow
  their own Alt+Enter binding. Refresh existing tabs after upgrading.
- Homebrew Bash with ble.sh suggestions; **Tab/Right** accepts ghost text,
  **Ctrl+R** searches history. New windows/splits inherit this configuration.
  Existing local shells must flush history before other shells can import it;
  a new terminal is not required. Details: [history and completion](docs/usage.md#suggestions-and-completion).
- Floating **↑ Upload**, then **Choose files** transfers to
  `~/Downloads/terminal-uploads/upload-…/` through a separate authenticated
  connection. After confirmed completion, quoted paths are pasted at the current
  terminal input cursor without Enter or clearing draft text. The upload dialog
  has an opt-out checkbox and **Retry upload** for stalled/canceled uploads.
  Connection setup retries once after 15 seconds; active transfers require a
  manual retry. Do not start an upload unless the user identifies files. [Upload guide](docs/usage.md#upload-documents).
- Start a regular shell. Do not automatically `codex resume` the desktop chat;
  that starts another interface and can trigger the conversation ownership lock.
  Users run CLI agents inside the shared shell and attach from either laptop.
- Preserve running programs and unfinished input. Do not send setup commands
  into an agent. The Mac must stay awake and online; Quick Tunnel URLs change
  when the tunnel restarts.

## Maintenance

Run these through the same non-login, host-side tool settings:

```bash
python3 ~/.codex/skills/shared-browser-terminal/scripts/browser_terminal.py stop
python3 ~/.codex/skills/shared-browser-terminal/scripts/browser_terminal.py style --font-size 15
python3 ~/.codex/skills/shared-browser-terminal/scripts/browser_terminal.py credentials
```

`stop` closes only managed browser access and leaves tmux/agents running.
`style` briefly reconnects browsers while preserving shells and the tunnel URL.
`credentials` displays the login: run it only when the user requests credentials.
Normally return the local file path, not the password. Runtime files and history
must remain outside Git. Default state: `/private/tmp/codex-browser-remote/`.

`status` is diagnostic and explicitly says `not_checked`; it does not certify
public access. `verify` is for targeted troubleshooting. See the
[usage guide](docs/usage.md) for diagnosis, custom state, uploads, and styling.

Missing dependencies only:

```bash
HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew install python bash tmux ttyd cloudflared trzsz-go
python3 ~/.codex/skills/shared-browser-terminal/scripts/install_blesh.py
```

Maintain source in [RutvikGupta/shared-browser-terminal](https://github.com/RutvikGupta/shared-browser-terminal).
Sync `SKILL.md`, `scripts/`, `assets/`, `agents/`, and `docs/` to this personal
installation after verified updates. Keep changes outside the user's project PR.
