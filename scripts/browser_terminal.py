"""Share a persistent Mac terminal through authenticated ttyd and Cloudflare."""

import argparse
from contextlib import contextmanager
import base64
import json
import getpass
import http.client
import ipaddress
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import signal
import socket
import ssl
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
    for name in ['open', 'start']:
        command = sub.add_parser(name)
        command.add_argument('--cwd', type=Path, default=Path.cwd())
        command.add_argument('--wait', type=int, default=45, metavar='SECONDS')
        if name == 'open':
            command.add_argument('--new-window', action='store_true')
            command.add_argument('--request-id', help='Reuse this ID when retrying the same new-window request')
        else:
            command.add_argument('--publish', action='store_true')
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
        address, dns_source = public_address(state, timeout=5)
        verify_http(state, config, public=True, address=address)
        verify_websocket(state, address=address)
        print('DNS verification source: ' + dns_source)
    else:
        prepare_state(state)
        with operation_lock(state):
            if args.action == 'stop':
                # Close browser access even if the tunnel takes time to drain.
                errors = []
                for kind in ['ttyd', 'tunnel']:
                    try:
                        stop_process(state, config, kind)
                    except RuntimeError as error:
                        errors.append(str(error))
                if errors:
                    raise RuntimeError('; '.join(errors))
                print('Remote access stopped. The tmux session and its programs remain running.')
            elif args.action == 'style':
                require_tools()
                session = find_session(config['session'])
                if session is None:
                    raise RuntimeError('Shared terminal is absent; run open first.')
                apply_tmux_theme(session)
                config['font_size'] = args.font_size
                save_config(state, config)
                ensure_credentials(state)
                restart_ttyd(state, config)
                print(json.dumps(status(state, config), indent=2))
            else:
                if not 1 <= args.wait <= 120:
                    parser.error('--wait must be between 1 and 120 seconds')
                request_id = getattr(args, 'request_id', None)
                if request_id and not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', request_id):
                    parser.error('--request-id must contain 1-80 letters, digits, hyphens, or underscores')
                result = open_terminal(
                    state, config, args.cwd,
                    publish=args.action == 'open' or args.publish,
                    new_window=getattr(args, 'new_window', False),
                    request_id=request_id, wait=args.wait)
                print(json.dumps(result, indent=2))
                return 2 if result['readiness'] == 'pending' else 0
    return 0


@contextmanager
def operation_lock(state):
    import fcntl
    with (state / 'operation.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another terminal operation is in progress. Retry the same command after it finishes.') from None
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def open_terminal(state, config, cwd, publish=True, new_window=False, request_id=None, wait=45):
    started = time.monotonic()
    require_tools()
    cwd = Path(cwd).resolve()
    if not cwd.is_dir():
        raise ValueError('Working directory does not exist: ' + str(cwd))
    session = find_session(config['session'])
    created = session is None
    if created:
        config['cwd'] = str(cwd)
        session = create_session(config)
    apply_tmux_theme(session)
    save_config(state, config)
    ensure_credentials(state)
    if not owned_process(state, config, 'ttyd'):
        restart_ttyd(state, config)
    try:
        verify_http(state, config, quiet=True, timeout=2)
    except OSError:
        # A recorded listener can be alive but no longer accepting connections.
        restart_ttyd(state, config)
        verify_http(state, config, quiet=True, timeout=2)
    window = None
    if created and new_window:
        window = run('tmux', 'display-message', '-p', '-t', session, '#{window_id}')
        remember_window(state, request_id, window)
    pending, dns_source = wait_for_public(state, config, wait) if publish else (None, None)
    if pending is None and new_window and window is None:
        window = requested_window(state, session, cwd, request_id)
    result = status(state, config)
    result.update(local_ready=True, readiness='pending' if pending else ('ready' if publish else 'local'),
                  session_created=created, window_id=window, dns_source=dns_source,
                  elapsed_seconds=round(time.monotonic() - started, 2))
    if pending is None and dns_source == 'cloudflare':
        result['notice'] = ('Public HTTPS and WebSocket checks passed using Cloudflare DNS. '
                            'The host DNS resolver is still lagging; browsers using that resolver '
                            'may need to wait for its cached failure to expire.')
    if pending:
        result.update(url=None, reason=pending,
                      next_step='Retry the same open command and request ID. Keep the existing shell and tunnel.')
    return result


def requested_window(state, session, cwd, request_id):
    path = state / 'window-requests.json'
    requests = json.loads(path.read_text()) if path.exists() else {}
    previous = requests.get(request_id) if request_id else None
    windows = run('tmux', 'list-windows', '-t', session, '-F', '#{window_id}').splitlines()
    if previous in windows:
        run('tmux', 'select-window', '-t', previous)
        return previous
    window = run('tmux', 'new-window', '-P', '-F', '#{window_id}',
                 '-t', session + ':', '-n', 'shell', '-c', str(cwd))
    remember_window(state, request_id, window)
    return window


def remember_window(state, request_id, window):
    if request_id:
        path = state / 'window-requests.json'
        requests = json.loads(path.read_text()) if path.exists() else {}
        requests[request_id] = window
        path.write_text(json.dumps(dict(list(requests.items())[-100:])) + '\n')


def wait_for_public(state, config, timeout):
    deadline = time.monotonic() + timeout
    pid_path = state / 'tunnel.pid'
    reused = (owned_process(state, config, 'tunnel') and pid_path.exists()
              and time.time() - pid_path.stat().st_mtime > 120)
    repair_after = time.monotonic() + min(10, timeout / 3)
    repaired = False
    announced = False
    try:
        ensure_tunnel(state, config, timeout=min(10, timeout))
    except PublicPending:
        pass
    last_error = 'Waiting for a tunnel address.'
    dns_source = None
    while time.monotonic() < deadline:
        try:
            if not read_url(state) and not discover_tunnel_url(state):
                raise PublicPending('Waiting for Cloudflare to assign a hostname.')
            probe_timeout = min(3, max(0.1, deadline - time.monotonic()))
            address, dns_source = public_address(state, timeout=probe_timeout)
            verify_http(state, config, public=True, quiet=True, timeout=probe_timeout, address=address)
            if time.monotonic() >= deadline:
                break
            verify_websocket(state, quiet=True, timeout=min(3, deadline - time.monotonic()), address=address)
            return None, dns_source
        except (PublicPending, OSError) as error:
            reason = getattr(error, 'reason', error)
            if isinstance(reason, ssl.SSLCertVerificationError):
                raise RuntimeError('Public TLS certificate verification failed.') from None
            last_error = str(error)
        if not announced:
            print('Waiting for public DNS and Cloudflare connectivity; keeping the shell running.', file=sys.stderr, flush=True)
            announced = True
        # Repair a stale existing tunnel once. A newly allocated hostname gets
        # the full readiness window; repeatedly restarting it only delays DNS.
        if reused and not repaired and time.monotonic() >= repair_after:
            print('Replacing the unavailable managed tunnel once.', file=sys.stderr, flush=True)
            stop_process(state, config, 'tunnel')
            repaired = True
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                ensure_tunnel(state, config, timeout=min(10, remaining))
            except PublicPending as error:
                last_error = str(error)
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(1, remaining))
    return last_error, dns_source


class PublicPending(RuntimeError):
    """A transient public DNS, edge, or tunnel-readiness failure."""


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
        'url': read_url(state), 'font_size': config['font_size'], 'readiness': 'not_checked',
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
    if result.returncode and any(word in result.stderr.lower() for word in ['operation not permitted', 'permission denied']):
        raise PermissionError('tmux socket access requires elevated tool permissions')
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
    # A second TERM ends cloudflared's graceful drain; only escalate a PID that
    # still matches the exact managed executable and endpoint.
    if owned_process(state, config, kind):
        os.kill(pid, signal.SIGTERM)
        time.sleep(0.2)
    if owned_process(state, config, kind):
        os.kill(pid, signal.SIGKILL)
        time.sleep(0.2)
    if owned_process(state, config, kind):
        raise RuntimeError('Managed process did not stop.')
    path.unlink(missing_ok=True)


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


def ensure_tunnel(state, config, timeout=40):
    running = owned_process(state, config, 'tunnel')
    if running and read_url(state):
        return
    if not running:
        stop_process(state, config, 'tunnel')
        (state / 'url.txt').unlink(missing_ok=True)
        (state / 'tunnel.log').write_text('')
        spawn(state, 'tunnel', [shutil.which('cloudflared'), 'tunnel', '--url',
                               f'http://127.0.0.1:{config["port"]}', '--no-autoupdate',
                               '--grace-period', '1s'])
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if discover_tunnel_url(state):
            return
        if not owned_process(state, config, 'tunnel'):
            raise PublicPending('Cloudflared exited before assigning a URL; inspect tunnel.log.')
        time.sleep(min(0.2, max(0, deadline - time.monotonic())))
    raise PublicPending('Cloudflare has not assigned a URL yet; the managed process is preserved.')


def discover_tunnel_url(state):
    path = state / 'tunnel.log'
    log = path.read_text() if path.exists() else ''
    urls = re.findall(r'https://[a-z0-9-]+\.trycloudflare\.com', log)
    if urls:
        (state / 'url.txt').write_text(urls[-1] + '\n')
        return urls[-1]
    return None


def public_address(state, timeout):
    """Diagnose stale host DNS without modifying system/browser DNS settings."""
    url = read_url(state)
    if not url:
        raise PublicPending('Waiting for a tunnel hostname.')
    host = url.split('://', 1)[1]
    pid_path = state / 'tunnel.pid'
    fresh = pid_path.exists() and time.time() - pid_path.stat().st_mtime < 120
    # Do not seed a router's negative cache by asking before public DNS exists.
    public_ip = cloudflare_address(host, timeout) if fresh else None
    try:
        answers = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        return answers[0][4][0], 'system'
    except socket.gaierror:
        return public_ip or cloudflare_address(host, timeout), 'cloudflare'


def cloudflare_address(host, timeout):
    request = urllib.request.Request(
        'https://cloudflare-dns.com/dns-query?name=' + host + '&type=A',
        headers={'Accept': 'application/dns-json'})
    # Only the public hostname goes to the DNS resolver, never credentials.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)
    with opener.open(request, timeout=timeout) as response:
        data = json.load(response)
    if data.get('Status') == 0:
        for answer in data.get('Answer', []):
            if answer.get('type') == 1:
                address = ipaddress.ip_address(answer['data'])
                if address.version == 4 and address.is_global:
                    return str(address)
    raise PublicPending('The hostname is not yet available in public DNS.')


class ResolvedHTTPSConnection(http.client.HTTPSConnection):
    """Connect to a resolved address while retaining hostname/certificate checks."""
    def __init__(self, host, address, timeout):
        super().__init__(host, timeout=timeout, context=ssl.create_default_context())
        self.address = address

    def connect(self):
        raw = socket.create_connection((self.address, 443), timeout=self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except Exception:
            raw.close()
            raise


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def verify_http(state, config, public=False, quiet=False, timeout=10, address=None):
    url = read_url(state) if public else f'http://127.0.0.1:{config["port"]}'
    if not url:
        raise RuntimeError('No public tunnel URL is recorded.')
    auth = 'Basic ' + base64.b64encode(credentials(state).encode()).decode()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)
    for name, headers, expected in [('anonymous', {}, 401),
                                    ('authenticated', {'Authorization': auth}, 200)]:
        if public and address:
            connection = ResolvedHTTPSConnection(url.split('://', 1)[1], address, timeout)
            try:
                connection.request('GET', '/', headers=headers)
                code = connection.getresponse().status
            finally:
                connection.close()
        else:
            try:
                with opener.open(urllib.request.Request(url, headers=headers), timeout=timeout) as response:
                    code = response.status
            except urllib.error.HTTPError as error:
                code = error.code
        if code != expected:
            error_type = PublicPending if public and (code >= 500 or code in (408, 429)) else RuntimeError
            raise error_type(f'{name}: HTTP {code}, expected {expected}')
        if not quiet:
            print(f'{"Public" if public else "Local"} {name}: HTTP {code}')


def verify_websocket(state, quiet=False, timeout=10, address=None):
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
    with socket.create_connection((address or host, 443), timeout=timeout) as raw:
        with ssl.create_default_context().wrap_socket(raw, server_hostname=host) as conn:
            conn.sendall(request.encode())
            response = b''
            while b'\r\n' not in response and len(response) < 4096:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                response += chunk
    if not response.startswith(b'HTTP/1.1 101 '):
        parts = response.split(b' ', 2)
        retryable = len(parts) > 1 and parts[1].isdigit() and int(parts[1]) >= 500
        error_type = PublicPending if retryable else RuntimeError
        raise error_type('Public WebSocket upgrade failed.')
    if not quiet:
        print('Public authenticated WebSocket: HTTP 101')


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except PermissionError:
        raise SystemExit('Run this host command with login=false and elevated tool permissions; ps/tmux access is sandbox-blocked.')
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        # Do not print subprocess argv: ttyd argv contains the password.
        message = 'Subprocess failed; inspect local logs.' if isinstance(error, subprocess.CalledProcessError) else str(error)
        raise SystemExit(message)
