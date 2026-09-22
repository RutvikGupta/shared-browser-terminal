# Usage and troubleshooting

Run the commands below from your checkout or personal skill directory. Substitute
an absolute script path when calling from another directory.

## Start, reconnect, and stop

`start --cwd PATH --publish` creates the `codex-browser` tmux session only when it
does not exist. For an existing session, it preserves the working directory,
shell, and programs. Start without `--publish` to prepare local access only:

```bash
python3 scripts/browser_terminal.py start --cwd "$HOME"
python3 scripts/browser_terminal.py status
```

When reconnecting, check `status` and `verify`, then open the saved URL. Do not
start another agent just to view the running one. `verify` expects a public URL;
for local-only operation, `start` checks local authentication itself.

`stop` ends the managed public tunnel and authenticated ttyd server while leaving
tmux running. Restarting with `start --publish` keeps that terminal but creates a
new URL. A browser refresh may be needed after a ttyd restart.

To end the shell too, exit its programs normally, then type `exit` in the shell.
Stop sharing before deliberately ending the session. Do not kill the entire tmux
server if it hosts unrelated work.

## Runtime files and credentials

Default runtime directory: `/private/tmp/codex-browser-remote/`.

| File | Purpose |
| --- | --- |
| `login.txt` | Plaintext `username:password`, restricted to the hosting user |
| `ttyd.pid`, `tunnel.pid` | IDs of the managed processes |
| `ttyd.log`, `tunnel.log` | Local diagnostic logs |
| `url.txt` | Current Cloudflare URL |
| `settings.json` | Session, port, working directory, and font settings |
| `theme.json` | Generated terminal palette |

The username defaults to the hosting Mac's username. The password is generated
randomly once and reused. These files are outside the source tree and must never
be committed, posted in an issue, or copied into a guide. Temporary state can be
removed by OS cleanup or reboot; tmux itself does not survive a reboot.

The browser uses HTTP Basic Auth. It may remember authentication internally;
credentials are not stored by this application in cookies, local storage, or
DevTools Cache Storage. Network requests and ttyd's `/token` response can expose
the Base64 representation of `username:password`. Base64 is reversible encoding,
not encryption: treat that value exactly like the password.

To rotate the login while retaining the shell, stop browser access, remove only
the managed credential file, and restart:

```bash
python3 scripts/browser_terminal.py stop
rm /private/tmp/codex-browser-remote/login.txt
python3 scripts/browser_terminal.py start --publish
python3 scripts/browser_terminal.py credentials
```

This also changes the Quick Tunnel URL. A fresh private browser window can help
if the old login is still remembered. If you use a custom state directory, use
that directory consistently in every command and remove its login file instead.

## Custom state or additional terminals

Put `--state-dir PATH` **before** the subcommand. The directory is created with
mode `0700`. A separate state directory alone does not allocate a different port
or tmux session. Set unique values before starting a second terminal:

```bash
mkdir -m 700 "$HOME/.local/state/browser-terminal-second"
cat > "$HOME/.local/state/browser-terminal-second/settings.json" <<'JSON'
{"session": "browser-second", "port": 7683, "font_size": 14}
JSON
python3 scripts/browser_terminal.py \
  --state-dir "$HOME/.local/state/browser-terminal-second" \
  start --cwd "$HOME" --publish
```

Use the same state directory for status, credentials, verification, styling,
and stop. Keep every terminal authenticated, use only trusted local state paths,
and never point a new instance at another instance's port or session.

## Theme, font, and scrollback

The default is the Warp Phenomenon palette, 14px text, line height 1.0, and a hidden
tmux status bar. This reproduces the colors, not Warp's photograph or GUI widgets.

```bash
python3 scripts/browser_terminal.py style --font-size 15
```

The accepted font range is 10–24px. Styling restarts ttyd, so browser clients briefly
disconnect, but it does not restart the shell, agent, or tunnel. Refresh afterward.

Mouse mode enables scrollback. If a program consumes mouse events, press Ctrl+B,
then `[` to enter tmux copy mode directly. Escape leaves the default copy mode;
`q` works with a vi copy-mode keymap.

Every new session starts with 50,000 lines of scrollback in its first window.
Additional windows inherit that limit and the configured Homebrew Bash startup,
so history suggestions and completion also work after Ctrl+B then C.
Older existing windows retain the limit they were created with; increasing a
session option cannot enlarge their buffers or recover discarded output. Do not
recreate a live terminal to enlarge its history without saving its work.

A colored strip left behind by an exited program can be screen content rather
than a toolbar. At an idle shell, Ctrl+L redraws without deleting typed input.

## Suggestions and completion

Homebrew Bash loads the user's existing login configuration and then ble.sh.
The default login shell and global `.bashrc` are not modified. Existing aliases,
completion functions, and history privacy filters are retained. `HISTFILE` stays
at its existing value, normally `~/.bash_history`; history append and sharing are
enabled. Saved history limits are 50,000 entries in memory and 100,000 on disk.

Type normally to see an inline suggestion. Tab or Right Arrow accepts it without
executing it. Enter executes the resulting command. When no suggestion is shown,
Tab uses ordinary command/path/argument completion. Ctrl+R searches history.
Suggestions may not appear immediately after a pasted block; continue typing.

If ble.sh is missing:

```bash
python3 scripts/install_blesh.py
```

For an existing **idle** Homebrew Bash shell, activate it with:

```bash
source "$HOME/.codex/skills/shared-browser-terminal/scripts/shell-features.bash"
```

To reload a changed key binding in a shell already running ble.sh:

```bash
source "$HOME/.codex/skills/shared-browser-terminal/scripts/blerc.bash"
```

For Apple's Bash 3.2, first finish running programs and preserve unfinished input.
Then flush history and replace only that idle shell:

```bash
history -a
exec /opt/homebrew/bin/bash --rcfile \
  "$HOME/.codex/skills/shared-browser-terminal/scripts/bashrc.bash" -i
```

Use `/usr/local/bin/bash` on Intel Homebrew. Do not send these shell commands into
an active agent or another interactive program. Shell suggestions do not apply
inside a Codex/Claude chat composer.

## Upload documents

The host needs `brew install trzsz-go`. The helper enables ttyd's `enableTrzsz`
client option, which transfers files over the existing terminal WebSocket.
Refresh a page opened before the option was enabled. Run `trz` at the browser's
Bash prompt to open the client laptop's file picker. Files land in the host's
current directory; `trz /path/to/destination` chooses a different existing folder.
The default does not overwrite existing files. Do not add `-y`/`--overwrite`
unless replacing files is intentional.

The files stay on the hosting Mac, not in the Git repository unless you select
a destination there. A file transfer is not an agent attachment: tell the agent
the resulting host path. Avoid selecting a project directory if the documents
should remain outside version control.

Do not start a transfer inside an agent's chat composer. Create another tmux
window with Ctrl+B then C if the agent is running, upload from its shell, and
switch back with Ctrl+B then P. Use one browser client for the transfer: multiple
clients attached to the same pane may all see the file-transfer prompt.

If the picker does not open, confirm `trz --version` works, refresh the browser,
and check that `enableTrzsz` is not overridden to false in the URL. A browser may
ask permission to select local files; canceling the picker cancels the transfer.
Keep the terminal connected until it reports completion. Drag-and-drop may also
work, but it can type a receive command, so use it only at an idle shell prompt.

## Connection diagnosis

1. Run `status` to identify the intended session, processes, and URL.
2. Run `verify` to check 401 without login, 200 with login, and a WebSocket 101.
3. Inspect the local logs if a check fails. Redact credentials before sharing logs.
4. Confirm the tmux pane shows the desired shell, not server logs or another app.

A newly created tunnel can take a short time to resolve at the edge. If the URL
was created but public verification fails, wait briefly and rerun `verify` while
preserving the tunnel. Cloudflared can conflict with an existing tunnel config
file; inspect its own log and Cloudflare's Quick Tunnel documentation rather than
overwriting unrelated configuration. Firewalls must permit the outbound tunnel;
this tool does not change network policy.

Always use `tmux attach -t '=codex-browser'` for exact session matching. Without
`=`, tmux can match a similarly named session when the intended one is absent.
The helper resolves numeric session IDs for configuration commands.

If port 7682 is occupied by an untracked process, inspect it and choose a free
port rather than killing an unknown process. The helper refuses to stop a process
whose saved PID no longer matches its expected executable and endpoint.

## Agent ownership locks

A browser terminal is a view onto a tmux shell. It does not mirror a desktop
agent conversation. If a resumed conversation says it is open in another app,
use an explicit handoff or start a fresh CLI conversation in the shared shell.
Once the CLI agent runs there, all attached terminal clients share that single
process. They can type concurrently, so coordinate input between clients.
