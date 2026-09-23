# Usage and troubleshooting

Run the commands below from your checkout or personal skill directory. Substitute
an absolute script path when calling from another directory.

## Start, reconnect, and stop

`open --cwd PATH` is the normal command for starting or reconnecting. It creates
the session only when absent, preserves active programs, checks local auth before
publishing, and verifies public HTTP and WebSocket access in the same invocation.
For an existing session, `--cwd` does not navigate an active shell.

```bash
python3 scripts/browser_terminal.py open --cwd "$HOME"
python3 scripts/browser_terminal.py open --cwd "$HOME" --new-window --request-id another-shell
```

`--new-window` creates and selects a shell in the existing session after public
readiness, or uses the first shell if it just created the session. Other windows
keep running. A request ID makes retries reuse that window; use a new ID for a
separate request. Up to 100 recent IDs are retained. Concurrent mutation commands
are rejected with a clear message rather than racing over processes and state.

Healthy access returns immediately after checks. Temporary DNS, HTTP 5xx, and
connection failures are retried within `--wait` seconds (default 45, maximum 120).
Network calls can slightly exceed that budget. An unavailable tunnel older than
two minutes may be replaced once per invocation. Newly launched tunnels are kept
to avoid delaying DNS through repeated restarts. Pending results exit 2, mask the
URL, and preserve state. Retry the same command and request ID once; if still
pending, use the diagnosis section. Authentication/TLS failures are not retried.

For a newly launched tunnel, public DNS is checked before asking the host resolver,
so premature lookups do not seed a cached failure in the router.
If host DNS fails but Cloudflare DNS resolves the hostname, the helper verifies
HTTPS and WebSocket access at that address while retaining the original Host,
SNI, and certificate hostname checks. The output says `dns_source: cloudflare`
and includes a notice. This does not change system DNS, browser settings, or
`/etc/hosts`. Browsers using a resolver with a cached NXDOMAIN may still fail until
that cache expires. Only the public hostname is sent to
[Cloudflare DNS over HTTPS](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/), never terminal credentials.

For Codex tool calls, use `login: false`, `workdir: /private/tmp`, and the normal
`require_escalated` tool permission mechanism. Login profiles can run unrelated
Git configuration writes; restricted process inspection can block `ps`/tmux.
These are host utilities, not project Docker jobs. Separate agent hooks that fail
before a tool call must be diagnosed independently; this helper does not edit them.

`start --cwd PATH` still prepares local-only access, and `start --publish` remains
compatible. `status` reports saved state with `readiness: not_checked`; use it for
diagnosis, not proof that a URL works. `verify` explicitly checks existing access.

`stop` ends the managed public tunnel and authenticated ttyd server while leaving
tmux running. `open` after stopping keeps the terminal but creates a new URL.
A browser refresh may be needed after a ttyd restart.

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
| `window-requests.json` | Recent request IDs and their tmux window IDs |
| `operation.lock` | Serializes startup, styling, and shutdown |
| `index.html` | Installed ttyd page with the floating upload controls |

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
python3 scripts/browser_terminal.py open
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
  open --cwd "$HOME"
```

Use the same state directory for status, credentials, verification, styling,
and stop. Keep every terminal authenticated, use only trusted local state paths,
and never point a new instance at another instance's port or session.

## Theme, font, and scrollback

The default is the Warp Phenomenon palette, 14px text, line height 1.0, a steady
(non-blinking) cursor, and a hidden tmux status bar. This reproduces the colors, not Warp's photograph or GUI widgets.

```bash
python3 scripts/browser_terminal.py style --font-size 15
```

The accepted font range is 10–24px. Styling restarts ttyd, so browser clients briefly
disconnect, but it does not restart the shell, agent, or tunnel. Refresh afterward.

Drag the **right scrollbar** to browse the active pane's tmux history. The
**bottom-right down-arrow button** returns to live output and restores keyboard
focus. The controls operate on tmux copy mode through a separate authenticated
connection; they never send Escape or other input to a running agent. They follow
the active pane when switching windows or splits. Other tmux menus are left alone.
The scrollbar also supports arrow keys, Page Up/Down, Home, and End when focused.

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

## Cursor during agent output

The browser uses a steady, non-blinking caret and does not hide it on idle or
output timers. Applications still control cursor visibility through normal
terminal escape sequences. Refresh existing tabs after upgrading to remove the
previous redraw-hiding workaround.

## Highlight and copy

Drag over terminal text, double-click a word, or triple-click a whole line
(including soft-wrapped continuations) with the primary mouse button. Highlighting
leaves your clipboard unchanged. To copy, press
**Command+C** on Mac or **Ctrl+Shift+C** on other platforms. The highlight stays
until you select again or interact with the terminal. Copying writes plain text
to the client laptop's clipboard and sends no input to the remote shell.
**Ctrl+C** retains its usual command-interrupt behavior.

Ordinary dragging selects in the browser, even with tmux mouse mode enabled.
Wheel/trackpad scrolling still reaches tmux history. Scroll to the desired output
first, then highlight the visible text; drag selection is limited to the visible
screen. Hold **Option/Alt** while clicking to use the terminal's normal mouse
handling instead. Browser/application shortcuts with modifiers are preserved.

Refresh an existing browser tab after upgrading to load the selection controls.

## Open terminal links

Hold **Command (⌘)** and click a visible HTTP/HTTPS URL to open it in a new
browser tab on your viewing laptop. The terminal stays open in its existing tab.
Ordinary clicks and drags continue to select text. The built-in terminal link
handler opens the destination without sending keystrokes to the shell.

## Multiline input in Codex

Press **Shift+Enter** to add a newline in the Codex composer. **Enter** still
submits the prompt. Refresh existing browser tabs after upgrading.

The browser maps Shift+Enter to Alt+Enter while the terminal has keyboard focus.
This uses [Codex's alternate newline binding](https://github.com/openai/codex/pull/20535)
through tmux without requiring extended keyboard support. It does not paste or
submit the draft. Other programs, including shells, follow their own Alt+Enter
binding; this is not a universal multiline editor. Custom Codex keymaps must keep
Alt+Enter assigned to insert-newline. IME confirmation, other modifiers, and
controls outside the terminal retain their normal handling.

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

No new terminal is needed to refresh history. At the source Bash prompt, run
`history -a` to flush commands still in that shell's memory. Shared ble.sh shells
import persisted history; at an idle destination Bash prompt `history -n` imports
it explicitly. Zsh uses a different history file/format. This does not recover
unsaved history from another program or add shell suggestions to an agent chat.

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

Click **↑ Upload → Browse**, or drag files into the drop area. Use ⌘-click on Mac,
Ctrl-click on Windows/Linux, or Shift-click for a range in the file picker. All files appear in one persistent list, with queued,
connecting, uploading, uploaded, canceled, or failed status. Each compact row shows its
file name, size, progress bar, and cancel/retry action. Completed rows stay visible
while other files upload, and survive closing/reopening the dialog (until page
reload). Closing returns keyboard focus to the terminal.

Uploads always use at most **3 simultaneous connections**, without a UI setting. Each
file uses a separate authenticated WebSocket on the existing terminal URL. The
receiver saves into its own unique folder under `~/Downloads/terminal-uploads/`.
This can reduce per-file round-trip waiting, but all connections share bandwidth
and disk capacity; no fixed speed improvement is promised.

Progress reports bytes acknowledged after writing on the Mac. Files are labeled
Uploaded only after the receiver flushes the complete file to disk and publishes
its final path. A zero-byte file still requires that final confirmation. The
client streams 64 KiB chunks with at most 256 KiB outstanding per connection;
it does not load whole files into memory. Partial files are removed on ordinary
disconnect/cancellation or a receiver timeout. A force-killed host process or
power loss can leave a hidden partial file.

**Cancel** affects only its file; **Retry** restarts only a failed or canceled
file. **Retry failed** handles all failed/canceled rows. Completed files
are not retransmitted. Closing the dialog cancels queued/active transfers;
reopening retains the selected File objects so Retry works without reselection.
The main terminal and its agent remain connected throughout.

Startup waits up to 15 seconds and retries once if no receiver has accepted the
file. Active uploads fail after 90 seconds without an acknowledgement and require
manual retry, preventing silent restarts of an in-progress transfer. If the
hosting Mac is asleep/offline, it must become reachable before retry can work.

When all transfers settle, successfully saved paths not already inserted are pasted
at the current terminal input cursor. Existing draft text is preserved; Enter is
never sent. The browser waits for tmux to leave history mode before pasting.
If insertion fails, the popup retains the saved paths and offers **Insert paths**
to retry without uploading again. Failed uploads do not block successful paths.
The dialog closes automatically once all listed files succeed; reopen Upload to
review retained rows. Failures keep the dialog open for retry. Uncheck **Insert paths**
to opt out. Filenames containing path separators or control characters
are rejected; spaces, Unicode, apostrophes, and shell metacharacters are preserved
and quoted as literal path text. Files are never overwritten.

The page and transfer code come from this local skill and the installed ttyd
binary, without CDN scripts. URL arguments select fixed handlers, not arbitrary
commands or destinations. New uploads use `arg=upload-stream`; the legacy
`arg=upload` and command-line trzsz receiver remain available. Both upload modes
are behind the same ttyd password and origin checks. The streaming mode uses
[ttyd's terminal WebSocket framing](https://github.com/tsl0922/ttyd/blob/main/html/src/components/terminal/xterm/index.ts).

The command-line alternative below lets you choose another destination.
The host needs `brew install trzsz-go`. The helper enables ttyd's `enableTrzsz`
client option, which transfers files over the existing terminal WebSocket.
Refresh a page opened before the option was enabled. Run `trz` at the browser's
Bash prompt to open the client laptop's file picker. Files land in the host's
current directory; `trz /path/to/destination` chooses a different existing folder.
The default does not overwrite existing files. Do not add `-y`/`--overwrite`
unless replacing files is intentional.

The files stay on the hosting Mac, not in the Git repository unless you select
a destination there. A file transfer is not an agent attachment: the inserted paths let the agent
read the host files after you submit your prompt. Avoid selecting a project directory if the documents
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
