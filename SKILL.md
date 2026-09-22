---
name: shared-browser-terminal
description: Share a persistent Mac terminal in a password-protected browser using tmux, ttyd, and a free Cloudflare Quick Tunnel. Use for "host my terminal", "browser terminal", "share this terminal", "remote-control my terminal", "the Cloudflare terminal", Warp-like terminal access from another laptop, or reconnecting, stopping, and styling that setup. Shares a terminal, not a desktop Codex conversation.
---

# Shared browser terminal

Host the shell and its programs on the user's Mac, keep them in tmux, and expose
the terminal through ttyd and an outbound Cloudflare Quick Tunnel. Both laptops
can attach to the same terminal. No SSH Remote Login, Cloudflare account, domain,
or Vercel deployment is needed for this temporary setup.

Source: [RutvikGupta/shared-browser-terminal](https://github.com/RutvikGupta/shared-browser-terminal).
Keep improvements to this tool in that standalone repository and sync the personal
installation when applying updates. All requested terminal preferences are defaults
for new sessions, windows, and splits.

Install this skill in the personal skills directory, outside project repositories.
Do not add terminal runtime files, credentials, or history to a project or PR.

## Recognize the user's intended workflow

- "The terminal we set up", "host my terminal", "browser terminal", "remote
  control like Warp", and "access my agents from the other Mac" refer to this
  setup when the user wants a browser showing a running local terminal.
- Launch a **regular shell** by default. Let the user run `codex`, `claude`, or
  other commands inside it. Two browsers, or a browser and local tmux client,
  can then control the very same terminal process.
- Do not automatically run `codex resume` with the current desktop chat ID.
  A second Codex interface can report "This conversation is open in another
  app". It does not mirror the desktop app. A conversation handoff is a separate
  user choice. An ordinary terminal already running outside tmux cannot simply
  be adopted by this setup without relaunching or a separate remote-control tool.
- The host must stay awake and online. Closing a browser leaves tmux running;
  sleeping/rebooting the host is different. A Quick Tunnel URL changes when its
  process restarts and has no uptime guarantee. Keep the tunnel when only
  adjusting font size or restarting ttyd.

## Tools and local state

Use the bundled Python standard-library helper:

```bash
python3 ~/.codex/skills/shared-browser-terminal/scripts/browser_terminal.py status
```

These are host-side tools, not repository/Docker Python jobs. Run outside a
repository when convenient. macOS process inspection, tmux sockets, network
access, and Homebrew may require tool sandbox escalation.

Default state is `/private/tmp/codex-browser-remote/` (private directory, mode
0700). It contains `login.txt` (0600, `username:password`), PID files, logs,
`url.txt`, `theme.json`, and `settings.json`. The URL and passwords are runtime
data; **never embed them in this skill or source code**. `/private/tmp` state
can disappear after reboot/cleanup. `--state-dir PATH` before the subcommand
can select another private local directory.

The defaults use tmux session `codex-browser`, authenticated ttyd on
`127.0.0.1:7682`, and the Cloudflare URL recorded in `url.txt`. The helper manages only its recorded listener and tunnel.
Inspect actual state rather than trusting historical PIDs.

## Start or reconnect

1. Run `status`. If the intended terminal and tunnel are alive, run `verify`,
   report the current URL, and reuse them. Do not reset a working terminal just
   because an agent is new to the conversation.
2. Install missing dependencies only when needed:

   ```bash
   HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew install bash tmux ttyd cloudflared trzsz-go
   ```

   Install history suggestions if they are not present:

   ```bash
   python3 ~/.codex/skills/shared-browser-terminal/scripts/install_blesh.py
   ```

3. When the user requests a shared browser terminal, start it in the intended
   working directory and publish the authenticated tunnel:

   ```bash
   python3 ~/.codex/skills/shared-browser-terminal/scripts/browser_terminal.py start --cwd /absolute/project/path --publish
   ```

   `start` alone prepares local access without publishing. Existing sessions
   are reused, so `--cwd` only controls creation; never silently navigate or send
   commands into a user's active program. The helper waits up to 40 seconds for
   a tunnel URL. If DNS/edge readiness lags, inspect the log and retry verification
   once after a short wait, preserving the existing tunnel and URL.
4. Verify anonymous HTTP **401**, authenticated HTTP **200**, and authenticated
   WebSocket **101**. The helper's `verify` checks these without sending terminal
   input. Also inspect the tmux pane to confirm it contains the intended shell or
   agent: a WebSocket handshake alone does not prove the right session is shown.
5. Report the URL, credentials-file location, and local attachment command:

   ```bash
   tmux attach -t '=codex-browser'
   ```

   Users can view the password locally with the `credentials` subcommand. Display
   it in chat only if explicitly requested. Do not place credentials in a URL,
   query string, logs, Git files, or diagnostic output. The ttyd credential is
   passed in process arguments, so it is visible to sufficiently privileged local
   process inspection; this is a temporary personal setup, not an SSO deployment.

Keep ttyd bound to loopback with password authentication and origin checking.
Verify authentication **before** starting a public tunnel. Do not publish the
old unauthenticated port 7681 or disable authentication to fix a connection.
The user's request to start this setup authorizes its normal authenticated tunnel;
do not invent an additional permission question. Still respect actual tool
approval requirements and any known organizational restrictions.

## Styling and preferred presentation

The established preference is **14px**, line height **1.0**, Warp **Phenomenon** colors: charcoal background
`#121212`, warm foreground `#faf9f6`, blue accent `#2e5d9e`, cursor
`#3780e9`, its exact normal/bright ANSI palette, and no tmux status bar. The palette comes from Warp’s official
`app/src/themes/default_themes.rs`. This reproduces the terminal colors; the
Warp background photograph and app-specific widgets are not part of ttyd.
Preserve these when reconnecting. Adjust font size in one-pixel steps unless the user specifies it:

```bash
python3 ~/.codex/skills/shared-browser-terminal/scripts/browser_terminal.py style --font-size 14
```

This briefly reconnects ttyd clients but preserves tmux, agent processes,
password, and tunnel URL. Ask the user to refresh the browser. Do not restart the
agent for a font-only change.

If Codex is entirely grayscale or its composer has no distinct background:

- Inspect emitted styles with `tmux capture-pane -e -p -t PANE_ID` before claiming
  a palette change fixes the problem. Codex must emit colors itself.
- New shells get `COLORTERM=truecolor` and no `NO_COLOR`. tmux pane background and
  foreground are explicitly set, and `xterm-256color:RGB` is enabled. These enable
  Codex's startup color/background probe and shaded input area.
- Updating tmux's environment cannot alter an already-running shell or agent's
  environment. If the agent is idle and a restart is necessary, explain it, exit
  normally, record **that agent's** resume ID, then resume with
  `unset NO_COLOR; export COLORTERM=truecolor; codex resume EXACT_ID`.
  Do not substitute the calling desktop chat's ID. Preserve model/settings and
  unfinished input. Never interrupt active work solely to restyle it.
- If still needed, consult the installed Codex version and current official docs
  rather than inventing a theme config key. Browser background changes cannot
  add semantic prompt coloring when the application emits none.

## Scrolling and screen space

Keep session option `mouse on` for wheel/trackpad scrolling and `status off` to
hide the bottom tmux bar. The helper applies both without sending keystrokes
into the shell or agent. Scroll up over the terminal to browse retained history;
press **Escape** to leave tmux copy mode and return to typing. A keyboard fallback
is **Ctrl+B**, then **[**, followed by Page Up or arrow keys.
Applications that handle mouse events themselves may consume scrolling; use the
keyboard fallback to access tmux history in that case.

The helper configures `history-limit 50000` before creating the first real pane,
so the initial and subsequent windows both receive it. Session `default-command`
loads the same Bash setup for new windows and splits. Existing windows
retain their original history limit (typically 2000); do not claim their buffers
were enlarged or recreate them just to increase retention. Inspect
`#{history_size}` and `#{history_limit}`. Never clear history while enabling scroll.
A blank colored line left by an exited TUI is screen content, not a toolbar:
when at the shell, Ctrl+L redraws the screen and preserves the typed command.

## Shell completion and history suggestions

Shared shells use Homebrew Bash (4+ required for automatic suggestions) with [ble.sh](https://github.com/akinomyoga/ble.sh), installed
locally at `~/.local/share/blesh`. The helper's dedicated `scripts/bashrc.bash`
loads the existing system/user login configuration (including aliases), then
`scripts/shell-features.bash`. No global Bash startup files are changed.

- Type a previous command's prefix for muted inline suggestions; **Tab** or **Right Arrow**
  at the end accepts the suggestion without executing it. **Enter** runs it.
- When no inline suggestion is visible, **Tab** completes commands, paths, and
  configured command arguments.
- **Ctrl+R** searches command history. History stays in the shell's existing
  `HISTFILE` (normally `~/.bash_history`), with append/sharing enabled; existing
  privacy filters are retained. Do not print or upload history during diagnosis.
- These features apply at the Bash prompt, not inside Codex's chat composer.
- For an existing idle Bash 4+ pane, source the following once; inspect the pane and
  preserve unfinished input first. Never send this into an active agent/program:

  ```bash
  source ~/.codex/skills/shared-browser-terminal/scripts/shell-features.bash
  ```

For an idle Apple Bash 3.2 pane, save history with `history -a`, then replace
that shell with `/opt/homebrew/bin/bash --rcfile
~/.codex/skills/shared-browser-terminal/scripts/bashrc.bash -i` using `exec`.
Use the actual Homebrew Bash path on Intel Macs. Preserve unfinished input;
never replace a shell running an agent. This does not change the login shell.

If ble.sh is absent, run the bundled `scripts/install_blesh.py` using Python 3.12+.
It downloads the official prebuilt release, extracts it with the tarfile data
filter, and installs it at `~/.local/share/blesh`.
Do not append the upstream global `.bashrc` example: this skill loads it only in
the shared terminal. Missing ble.sh leaves the shell usable with a notice.

## Upload documents from the client laptop

The default browser page has a floating **↑ Upload** button in the upper-right.
Click it, then **Choose files** in the dialog. This starts a separate authenticated
receiver and saves into `~/Downloads/terminal-uploads`, without typing into or
restarting the shared agent. The helper generates the custom page from the locally
installed ttyd bundle and `assets/upload-controls.html`; keep both scripts and
assets when installing/updating the skill. Refresh the page after deployment.
Chrome/Edge supports the native picker. Wait for transfer completion before closing.

For a command-line alternative, the ttyd client enables `enableTrzsz=true`;
Homebrew `trzsz-go` supplies `trz`.
After refreshing the browser, run `trz` at an idle Bash prompt. A browser file
picker selects files from the client laptop and transfers them into the host's
current directory. PDFs, Word documents, images, and other files are supported.
Use `trz /absolute/destination` for a chosen directory (create it first).
Keep the default non-overwrite behavior; do not add `--overwrite` implicitly.
Uploads use the existing authenticated terminal WebSocket and tunnel.

Do not type `trz` or drag files into an active agent's input. If an agent is busy,
use another tmux window (Ctrl+B then C), upload there, and return (Ctrl+B then P).
The agent can read the resulting host file path. Coordinate attached clients so
only the uploading browser responds to the transfer prompt. Drag-and-drop can
trigger the receive command in supported browsers; the explicit `trz` picker is
the primary documented flow. Do not start an upload on behalf of the user unless
they select or identify a file to transfer.

## Troubleshooting and stopping

- **Server logs instead of shell:** tmux prefix matching can select
  `codex-browser-server` after `codex-browser` exits. Use exact equality in
  session discovery and `tmux attach -t '=codex-browser'`. For other commands,
  resolve numeric session (`$2`) and pane (`%2`) IDs instead of assuming every
  tmux command interprets the `=` prefix the same way. Never hardcode those IDs.
- **Dead/absent session:** inspect first. Recreate a shell only when missing;
  don't replace an active pane or automatically resume a desktop chat.
- **Connection failure:** check owned processes, local auth responses, tunnel
  log, public auth responses, and WebSocket upgrade in that order. A failed
  network precheck does not prove the tunnel failed if authenticated access works.
- **Locked Codex chat:** explain the desktop conversation ownership lock. Use a
  shell/new CLI agent or an explicit handoff; don't try to bypass the lock.
- **Stop sharing:**

  ```bash
  python3 ~/.codex/skills/shared-browser-terminal/scripts/browser_terminal.py stop
  ```

  Stops the managed tunnel and authenticated ttyd only. Keeps tmux and its programs
  running. Do not kill the tmux server, unrelated sessions, or all `cloudflared`
  processes. The helper verifies recorded process identity before signaling it.

## Sources

- [ttyd options](https://github.com/tsl0922/ttyd)
- [ttyd display options](https://github.com/tsl0922/ttyd/wiki/Client-Options)
- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- [tmux guide](https://github.com/tmux/tmux/wiki/Getting-Started)

- [Warp Phenomenon palette source](https://github.com/warpdotdev/warp/blob/master/app/src/themes/default_themes.rs)
