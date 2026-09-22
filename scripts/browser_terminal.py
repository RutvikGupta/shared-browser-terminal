"""Share a persistent Mac terminal through authenticated ttyd and Cloudflare."""

import argparse
import base64
import json
import getpass
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request


DEFAULT_STATE = Path('/private/tmp/codex-browser-remote')
# Warp Phenomenon palette: app/src/themes/default_themes.rs (2026-09-22).
THEME = {'background': '#121212', 'foreground': '#faf9f6', 'cursor': '#3780e9', 'cursorAccent': '#121212', 'selectionBackground': '#2e5d9e', 'black': '#121212', 'red': '#d22d1e', 'green': '#1ca05a', 'yellow': '#e5a01a', 'blue': '#3780e9', 'magenta': '#bf409d', 'cyan': '#799c92', 'white': '#faf9f6', 'brightBlack': '#292929', 'brightRed': '#ae756f', 'brightGreen': '#789b88', 'brightYellow': '#bd9f65', 'brightBlue': '#6f839f', 'brightMagenta': '#a57899', 'brightCyan': '#bfc5c3', 'brightWhite': '#ffffff'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', type=Path, default=DEFAULT_STATE)
    sub = parser.add_subparsers(dest='action', required=True)
    sub.add_parser('status')
    sub.add_parser('verify')
    start = sub.add_parser('start')
    start.add_argument('--cwd', type=Path, default=Path.cwd())
    start.add_argument('--publish', action='store_true', help='Start the public, password-protected tunnel')
    style = sub.add_parser('style')
    style.add_argument('--font-size', type=int, default=14, choices=range(10, 25))
    sub.add_parser('stop', help='Stop remote access; keep tmux and agents running')
    sub.add_parser('credentials', help='Explicitly display the terminal login')
    args = parser.parse_args()
    state = args.state_dir
    config = read_config(state)
    if args.action == 'credentials':
        print((state / 'login.txt').read_text().strip())
    elif args.action == 'status':
        print(json.dumps(status(state, config), indent=2))
    elif args.action == 'verify':
        verify_http(state, config)
        verify_http(state, config, public=True)
        verify_websocket(state)
    elif args.action == 'stop':
        stop_process(state, config, 'tunnel')
        stop_process(state, config, 'ttyd')
        print('Remote access stopped. The tmux session and its programs remain running.')
    else:
        prepare_state(state)
        require_tools()
        session_id = find_session(config['session'])
        if args.action == 'start':
            if session_id is None:
                config['cwd'] = str(args.cwd.resolve())
                session_id = create_session(config)
        if session_id is None:
            raise RuntimeError('Shared terminal is absent; run start first.')
        apply_tmux_theme(session_id)
        if args.action == 'style':
            config['font_size'] = args.font_size
        save_config(state, config)
        ensure_credentials(state)
        if args.action == 'style' or not owned_process(state, config, 'ttyd'):
            restart_ttyd(state, config)
        verify_http(state, config)
        if args.action == 'start' and args.publish:
            ensure_tunnel(state, config)
            verify_http(state, config, public=True)
            verify_websocket(state)
        print(json.dumps(status(state, config), indent=2))


def create_session(config):
    # Set history retention before creating the user's first real pane.
    # The temporary window never runs a user shell or agent.
    session_id, bootstrap_window = run(
        'tmux', 'new-session', '-d', '-P', '-F', '#{session_id} #{window_id}',
        '-s', config['session'], '-n', 'initializing', '-c', config['cwd'],
        '-x', '140', '-y', '45', '/bin/sleep 300').split()
    try:
        apply_tmux_theme(session_id)
        window = run('tmux', 'new-window', '-d', '-P', '-F', '#{window_id}',
                     '-t', session_id + ':', '-n', 'terminal', '-c', config['cwd'])
        run('tmux', 'swap-window', '-d', '-s', window, '-t', bootstrap_window)
        run('tmux', 'select-window', '-t', window)
        run('tmux', 'kill-window', '-t', bootstrap_window)
        return session_id
    except Exception:
        # Clean up only the new session owned by this invocation.
        subprocess.run(['tmux', 'kill-session', '-t', session_id], capture_output=True)
        raise


def shell_command():
    return shlex.join(['/usr/bin/env', '-u', 'NO_COLOR', 'COLORTERM=truecolor',
                       bash_executable(), '--rcfile',
                       str(Path(__file__).with_name('bashrc.bash').resolve()), '-i'])


def bash_executable():
    for candidate in ['/opt/homebrew/bin/bash', '/usr/local/bin/bash']:
        if Path(candidate).is_file():
            return candidate
    raise RuntimeError('Install current Bash for history suggestions: brew install bash')


def read_config(state):
    config = {'session': 'codex-browser', 'port': 7682, 'font_size': 14,
              'cwd': str(Path.cwd())}
    if (state / 'settings.json').exists():
        config.update(json.loads((state / 'settings.json').read_text()))
    if not re.fullmatch(r'[a-zA-Z0-9_-]+', config['session']):
        raise ValueError('Invalid tmux session name')
    if not 1024 <= config['port'] <= 65535:
        raise ValueError('Invalid terminal port')
    return config


def status(state, config):
    return {
        'session': config['session'], 'session_id': find_session(config['session']),
        'terminal_running': owned_process(state, config, 'ttyd'),
        'tunnel_running': owned_process(state, config, 'tunnel'),
        'url': read_url(state), 'font_size': config['font_size'],
        'credentials_file': str(state / 'login.txt'),
        'local_attach': "tmux attach -t '=" + config['session'] + "'",
    }


def prepare_state(state):
    state.mkdir(parents=True, mode=0o700, exist_ok=True)
    state.chmod(0o700)


def save_config(state, config):
    (state / 'settings.json').write_text(json.dumps(config, indent=2) + '\n')
    (state / 'theme.json').write_text(json.dumps(THEME, indent=2) + '\n')


def require_tools():
    packages = {'tmux': 'tmux', 'ttyd': 'ttyd', 'cloudflared': 'cloudflared', 'trz': 'trzsz-go'}
    missing = [package for command, package in packages.items() if not shutil.which(command)]
    if missing:
        raise RuntimeError('Install missing tools with Homebrew: ' + ' '.join(missing))
    bash_executable()
    if not (Path.home() / '.local/share/blesh/ble.sh').is_file():
        raise RuntimeError('Install history suggestions first: python3 ' +
                           str(Path(__file__).with_name('install_blesh.py').resolve()))


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def find_session(name):
    result = subprocess.run(['tmux', 'list-sessions', '-F', '#{session_id} #{session_name}'],
                            text=True, capture_output=True)
    for line in result.stdout.splitlines():
        session_id, session_name = line.split(' ', 1)
        if session_name == name:
            return session_id
    return None


def apply_tmux_theme(session_id):
    # Numeric IDs avoid tmux's differing prefix-match rules across commands.
    run('tmux', 'set-environment', '-t', session_id, 'COLORTERM', 'truecolor')
    features = run('tmux', 'show-options', '-s', 'terminal-features')
    if 'xterm-256color:RGB' not in features:
        run('tmux', 'set-option', '-as', 'terminal-features', ',xterm-256color:RGB')
    for option in ['window-style', 'window-active-style']:
        run('tmux', 'set-option', '-w', '-t', session_id + ':', option,
            'fg=#faf9f6,bg=#121212')
    for option, value in {
        'mouse': 'on',
        'history-limit': '50000',
        'default-shell': bash_executable(),
        'default-command': shell_command(),
        'status': 'off',
        'status-style': 'fg=#bfc5c3,bg=#292929',
        'status-left': '#[fg=#3780e9,bold] SHARED TERMINAL #[default] ',
        'status-left-length': '24',
        'status-right': '#[fg=#bfc5c3]%H:%M ',
    }.items():
        run('tmux', 'set-option', '-t', session_id, option, value)


def ensure_credentials(state):
    path = state / 'login.txt'
    if not path.exists():
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as file:
            username = getpass.getuser()
            if ':' in username or '\n' in username:
                raise ValueError('Invalid login username')
            file.write(username + ':' + secrets.token_urlsafe(32) + '\n')
    path.chmod(0o600)


def credentials(state):
    value = (state / 'login.txt').read_text().strip()
    if ':' not in value or len(value.split(':', 1)[1]) < 32:
        raise ValueError('Terminal password is missing or too short')
    return value


def process_matches(command, config, kind):
    # Never stop a process based only on a potentially stale PID file.
    # ttyd mutates argv while parsing client options, so ps may omit the tail.
    if kind == 'ttyd':
        return (re.match(r'^\S*/ttyd\s', command) is not None
                and f' -p {config["port"]} ' in command
                and ' -i 127.0.0.1 ' in command)
    return (re.match(r'^\S*/cloudflared\s', command) is not None
            and f' tunnel --url http://127.0.0.1:{config["port"]} ' in command)


def owned_process(state, config, kind):
    path = state / (kind + '.pid')
    if not path.exists():
        return False
    pid = int(path.read_text())
    result = subprocess.run(['ps', '-ww', '-p', str(pid), '-o', 'command='],
                            text=True, capture_output=True)
    return result.returncode == 0 and process_matches(result.stdout.strip(), config, kind)


def stop_process(state, config, kind):
    path = state / (kind + '.pid')
    if not path.exists():
        return
    pid = int(path.read_text())
    if not owned_process(state, config, kind):
        result = subprocess.run(['ps', '-p', str(pid), '-o', 'pid='], capture_output=True)
        if result.returncode == 0:
            raise RuntimeError('PID belongs to an unexpected process; refusing to stop it.')
        path.unlink()
        return
    os.kill(pid, signal.SIGTERM)
    for _ in range(50):
        if not owned_process(state, config, kind):
            path.unlink(missing_ok=True)
            return
        time.sleep(0.1)
    raise RuntimeError('Process has not stopped; no replacement was started.')


def spawn(state, kind, args):
    with open(state / (kind + '.log'), 'ab') as log:
        proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=log,
                                stderr=log, start_new_session=True)
    (state / (kind + '.pid')).write_text(str(proc.pid))


def ttyd_options(config):
    return ['theme=' + json.dumps(THEME), f'fontSize={config["font_size"]}',
            'lineHeight=1.0', 'cursorBlink=true', 'cursorStyle=bar',
            'titleFixed=Shared Terminal', 'disableLeaveAlert=false', 'enableTrzsz=true']


def restart_ttyd(state, config):
    from terminal_page import write_terminal_page
    page = write_terminal_page(state, shutil.which('ttyd'))
    stop_process(state, config, 'ttyd')
    with socket.socket() as sock:
        if sock.connect_ex(('127.0.0.1', config['port'])) == 0:
            raise RuntimeError('Terminal port is in use by an untracked process.')
    args = [shutil.which('ttyd'), '-W', '-O', '-a', '-I', str(page), '-i', '127.0.0.1',
            '-p', str(config['port']), '-c', credentials(state)]
    for option in ttyd_options(config):
        args.extend(['-t', option])
    args.extend([sys.executable, str(Path(__file__).with_name('terminal_connection.py').resolve()),
                 config['session']])
    spawn(state, 'ttyd', args)
    for _ in range(40):
        try:
            verify_http(state, config, quiet=True)
            return
        except (OSError, RuntimeError):
            time.sleep(0.1)
    raise RuntimeError('Password-protected terminal did not become ready; inspect ttyd.log.')


def read_url(state):
    path = state / 'url.txt'
    if not path.exists():
        return None
    url = path.read_text().strip()
    if not re.fullmatch(r'https://[a-z0-9-]+\.trycloudflare\.com', url):
        raise ValueError('Unexpected tunnel hostname; refusing to send credentials')
    return url


def ensure_tunnel(state, config):
    if owned_process(state, config, 'tunnel'):
        return
    stop_process(state, config, 'tunnel')
    (state / 'url.txt').unlink(missing_ok=True)
    (state / 'tunnel.log').write_text('')
    spawn(state, 'tunnel', [shutil.which('cloudflared'), 'tunnel', '--url',
                           f'http://127.0.0.1:{config["port"]}', '--no-autoupdate'])
    for _ in range(40):
        log = (state / 'tunnel.log').read_text()
        urls = re.findall(r'https://[a-z0-9-]+\.trycloudflare\.com', log)
        if urls:
            (state / 'url.txt').write_text(urls[-1] + '\n')
            return
        time.sleep(1)
    raise RuntimeError('Tunnel address not available after 40s; inspect tunnel.log.')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def verify_http(state, config, public=False, quiet=False):
    url = read_url(state) if public else f'http://127.0.0.1:{config["port"]}'
    if not url:
        raise RuntimeError('No public tunnel URL is recorded.')
    auth = 'Basic ' + base64.b64encode(credentials(state).encode()).decode()
    opener = urllib.request.build_opener(NoRedirect)
    for name, headers, expected in [('anonymous', {}, 401),
                                    ('authenticated', {'Authorization': auth}, 200)]:
        try:
            with opener.open(urllib.request.Request(url, headers=headers), timeout=10) as response:
                code = response.status
        except urllib.error.HTTPError as error:
            code = error.code
        if code != expected:
            raise RuntimeError(f'{name}: HTTP {code}, expected {expected}')
        if not quiet:
            print(f'{"Public" if public else "Local"} {name}: HTTP {code}')


def verify_websocket(state):
    import ssl
    url = read_url(state)
    if not url:
        raise RuntimeError('No public tunnel URL is recorded.')
    host = url.split('://', 1)[1]
    auth = base64.b64encode(credentials(state).encode()).decode()
    key = base64.b64encode(secrets.token_bytes(16)).decode()
    request = (f'GET /ws HTTP/1.1\r\nHost: {host}\r\nOrigin: {url}\r\n'
               f'Upgrade: websocket\r\nConnection: Upgrade\r\n'
               f'Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n'
               f'Sec-WebSocket-Protocol: tty\r\nAuthorization: Basic {auth}\r\n\r\n')
    with socket.create_connection((host, 443), timeout=10) as raw:
        with ssl.create_default_context().wrap_socket(raw, server_hostname=host) as conn:
            conn.sendall(request.encode())
            response = b''
            while b'\r\n' not in response and len(response) < 4096:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                response += chunk
    if not response.startswith(b'HTTP/1.1 101 '):
        raise RuntimeError('Public WebSocket upgrade failed.')
    print('Public authenticated WebSocket: HTTP 101')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        # Do not print subprocess argv: ttyd argv contains the password.
        message = 'Subprocess failed; inspect local logs.' if isinstance(error, subprocess.CalledProcessError) else str(error)
        raise SystemExit(message)
