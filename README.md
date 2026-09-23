# Shared Browser Terminal

Open a persistent terminal on your Mac from a browser on another laptop. Both
screens control the same shell and the same running programs, including terminal
agents such as Codex or Claude Code.

This combines **tmux**, **ttyd**, and a **Cloudflare Quick Tunnel**. The Mac runs the
terminal; Cloudflare forwards browser traffic to it. You do not need SSH Remote
Login, an open inbound port, a domain, or a Cloudflare account.

## Features

- Persistent shared shell: closing the browser does not stop your commands.
- Password-protected browser access with a random password and HTTPS public URL.
- Warp Phenomenon terminal colors, 14px text, a steady cursor without idle hiding, and no tmux status bar.
- Mouse/trackpad scrollback: 50,000 lines in the first and subsequent windows.
- Floating Upload button: select multiple files together; all completed host paths
  are inserted into terminal input without Enter.
  Persistent per-file progress, up to three concurrent uploads, and individual retry/cancel.
- Cursor stays hidden during output redraws and returns when output settles or you type.
- Persistent browser text selection: drag, release, then **⌘C** to copy on Mac.
- Local Bash history suggestions: **Tab** or **Right Arrow** accepts ghost text.
- Normal Tab completion when no suggestion is visible; **Ctrl+R** searches history.
- Optional personal Codex skill: invoke **`$shared-browser-terminal`**.
- No project repository changes and no global shell startup edits.

## Requirements

A hosting Mac with [Homebrew](https://brew.sh/), Python **3.12+**, and an outbound
connection that permits Cloudflare Tunnel. The client laptop only needs a browser.
The host must remain awake and online.

```bash
brew install python bash tmux ttyd cloudflared trzsz-go
```

The shared terminal uses Homebrew Bash. Apple's bundled Bash 3.2 lacks the idle
processing support needed for automatic suggestions. This does not change your
Mac's default login shell.

## Quick start

Install as a personal Codex skill, outside your project:

```bash
mkdir -p "$HOME/.codex/skills"
git clone https://github.com/RutvikGupta/shared-browser-terminal.git \
  "$HOME/.codex/skills/shared-browser-terminal"
cd "$HOME/.codex/skills/shared-browser-terminal"
python3 scripts/install_blesh.py
```

If that directory already exists, preserve it before cloning. For an existing
Git checkout of this repository, use `git pull --ff-only` instead. If you use a
custom `CODEX_HOME`, install under its `skills/` directory and adjust paths below.

Start a shell in your desired directory and publish it:

```bash
python3 scripts/browser_terminal.py open --cwd "$HOME"
```

The command reuses a healthy terminal or creates and verifies one. It prints a random `https://…trycloudflare.com` URL and checks that:

1. Anonymous access returns **401**.
2. Authenticated access returns **200**.
3. The authenticated WebSocket upgrades with **101**.

Only `readiness: ready` means the public checks passed. Temporary DNS/edge
failures are retried within a 45-second readiness budget; an unavailable old
tunnel is replaced at most once. A pending result exits with code 2 and preserves
the shell. Cloudflare DNS can verify a link when the host resolver lags; the
result includes a notice because browser DNS may still be affected.

To create another shell without interrupting an agent:

```bash
python3 scripts/browser_terminal.py open --cwd "$HOME" --new-window --request-id my-next-shell
```

Use a different request ID for each new shell; repeat the same ID when retrying.

View your generated login locally:

```bash
python3 scripts/browser_terminal.py credentials
```

Open the printed URL on the other laptop and enter that username and password.
Run your commands or start an agent in the browser terminal. Attach locally to
that exact same shell with:

```bash
tmux attach -t '=codex-browser'
```

Detach the local tmux client with **Ctrl+B**, then **D**. You can also run the
scripts from a normal checkout without installing a Codex skill.

## Everyday controls

| Action | Control |
| --- | --- |
| Highlight terminal text | Drag, double-click a word, or triple-click a whole line |
| Copy highlighted text | ⌘C (Mac) or Ctrl+Shift+C; highlighting alone never copies |
| Accept the visible inline suggestion | Tab or Right Arrow at the end of the input |
| Complete a command/path when no suggestion is visible | Tab |
| Search local command history | Ctrl+R |
| Open a web URL in a new browser tab | Command-click the link |
| Add a newline in the Codex composer | Shift+Enter |
| Run the accepted/typed command | Enter |
| Scroll terminal output | Mouse wheel, trackpad, or drag the right scrollbar |
| Return to live output | Bottom-right down-arrow button |
| Open tmux history explicitly | Ctrl+B, then `[` |
| Leave tmux history | Escape (or `q` if using a vi copy-mode keymap) |
| Redraw an idle shell without deleting typed input | Ctrl+L |

New tmux windows and splits inherit the same Bash setup automatically.
Completion and suggestions work at the Bash prompt, not inside an agent's chat
composer. History suggestions run locally; no AI service receives your history.

```bash
# Inspect existing processes and the current URL.
python3 scripts/browser_terminal.py status

# Check local/public authentication and public WebSocket access.
python3 scripts/browser_terminal.py verify

# Adjust text size; preserves the shell and tunnel URL. Refresh the browser.
python3 scripts/browser_terminal.py style --font-size 15

# Stop browser access; preserve the tmux shell and its running programs.
python3 scripts/browser_terminal.py stop
```

## Upload documents

Refresh the terminal page after upgrading. Click **↑ Upload → Browse**, or drop files into the dialog.
Each file keeps a compact row with its name, size, progress, and cancel/retry
action. Completed rows remain visible until you reload the
page; closing and reopening the dialog keeps the list.

Up to **three files upload concurrently**, with no setting to manage. Parallel connections can reduce waiting on network round
trips, but share your network and disk bandwidth; higher concurrency is not a
guarantee of higher throughput. Progress advances when the Mac acknowledges
written bytes, and a file becomes Uploaded only after it is fully saved.

Cancel or retry individual files without restarting successful uploads or the
main terminal. Closing cancels unfinished uploads; reopen and retry them without
selecting the files again. Each file uses its own unique folder under
`~/Downloads/terminal-uploads/`, avoiding filename collisions.

After the transfers finish, successfully saved paths are inserted into terminal
input once, without clearing existing text or sending Enter. History mode is
closed before insertion. If insertion fails, **Insert paths** retries without
uploading again; a failed upload does not block paths from successful files.
Uncheck **Insert paths** to opt out. The dialog closes automatically after all
listed files succeed and their paths are inserted, returning focus to the terminal.
Reopen Upload to review the list; failures stay open for retry. Uploads use independent authenticated
connections through the same ttyd/Cloudflare URL and password, without another
server or account. The button uses the browser's standard multi-file picker.

For uploads into the shell's current directory instead, run at the **shell prompt**:

```bash
trz
```

Select PDFs, Word documents, images, or other files in the browser file picker.
They are saved to the hosting Mac's current terminal directory, ready for your
agent to read. To choose a destination explicitly:

```bash
mkdir -p "$HOME/Downloads/terminal-uploads"
trz "$HOME/Downloads/terminal-uploads"
```

Do not run this inside a Codex/Claude chat composer. If the agent is busy, press
**Ctrl+B, then C** for another tmux window and upload from its shell. Return with
**Ctrl+B, then P**, and give the agent the uploaded file's host path. Avoid having
multiple browsers respond to the same transfer prompt. No additional server,
account, or password is needed. See [upload troubleshooting](docs/usage.md#upload-documents).

## Use with Codex

After installing the personal skill, start a new Codex session if it is not yet
listed. Ask:

> Use $shared-browser-terminal to host a terminal for this project.

Or:

> Reconnect my browser terminal.

The skill uses one `open` command with a non-login host shell, preserving running
work and keeping runtime data outside project repositories. It does not require
an agent to inspect code or run a separate status/verify sequence before startup.

This shares a **terminal process**, not an existing desktop Codex conversation.
Starting a second `codex resume` for a conversation open in another app can trigger
an ownership lock. Start your CLI agent inside the shared terminal and attach to
that terminal from both laptops. Existing programs outside tmux are not migrated.

## Security and limitations

The URL gives access to a shell with your Mac user's permissions after login.
Treat the password and any Basic Auth token as credentials. The helper binds ttyd
to loopback, enables origin checking, and verifies authentication before starting
the tunnel. The public URL uses HTTPS; Cloudflare terminates that connection.
This is not end-to-end encryption excluding Cloudflare.

Credentials are stored in a local plaintext file with mode `0600`, inside a `0700`
runtime directory. ttyd also receives them through process arguments, which may
be visible to other sufficiently privileged local processes. This is a temporary
personal setup, not SSO, MFA, or a hardened multi-user hosting service.

Cloudflare Quick Tunnels need no account or domain, but have no uptime guarantee.
The random URL changes when the tunnel restarts. Your Mac remains the host: sleep,
network loss, reboot, or closing its lid can interrupt access. `stop` closes the
managed tunnel and ttyd listener; it does not erase saved credentials or history.

See the [usage and troubleshooting guide](docs/usage.md) for runtime files,
password rotation, custom sessions, history retention, and recovery.

## Development

```bash
python3 -m unittest discover -s scripts -p 'test_*.py'
for script in scripts/*.bash; do bash -n "$script" || exit; done
```

For a real terminal test after installing dependencies:

```bash
python3 scripts/smoke_test_shell.py
python3 scripts/smoke_test_session.py
```

These use isolated tmux servers and synthetic history. They check visible
suggestions, Tab acceptance without execution, path completion, history search,
and inheritance in new windows and splits without reading your command history
or touching your live terminal.

For browser selection and clipboard checks, install Playwright and its Chromium
browser in your own test environment, then run:

```bash
node scripts/smoke_test_selection.cjs
node scripts/smoke_test_upload.cjs
```

Set `PLAYWRIGHT_MODULE` to an installed Playwright module path if necessary. This
uses a separate authenticated loopback terminal and synthetic text, checking drag
release, clipboard copying, Ctrl+C delivery, Shift+Enter/Enter delivery through
tmux, modifier and IME handling, Command-click link opening without shell input,
and wheel scrollback. The upload test transfers real binary files concurrently,
checks persistent progress and exact saved bytes, and exercises independent
failures, cancellation, timeouts, retries, and safe path insertion.

## Credits

- [tmux](https://github.com/tmux/tmux): persistent terminal sessions.
- [ttyd](https://github.com/tsl0922/ttyd): browser terminal and authentication.
- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/): outbound tunnel.
- [trzsz](https://github.com/trzsz/trzsz-go): file uploads over the terminal connection.
- [ble.sh](https://github.com/akinomyoga/ble.sh): Bash line editing and suggestions.
- [Warp Phenomenon palette](https://github.com/warpdotdev/warp/blob/master/app/src/themes/default_themes.rs): terminal colors. No Warp background images or application code are included.

MIT licensed. Third-party tools are installed separately and retain their own licenses.
