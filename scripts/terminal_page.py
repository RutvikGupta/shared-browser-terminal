"""Add local keyboard, selection, and upload controls to the HTML embedded in the installed ttyd binary."""

import base64
import gzip
from pathlib import Path
import secrets
import socket
import subprocess
import time
import urllib.error
import urllib.request


def write_terminal_page(state, executable):
    page = builtin_page(executable)
    assets = Path(__file__).resolve().parent.parent / 'assets'
    controls = ''.join((assets / name).read_text() for name in
                       ['selection-controls.html', 'keyboard-controls.html', 'scroll-controls.html', 'upload-transport.html', 'upload-controls.html'])
    return write_page(state / 'index.html', page, controls)


def write_page(path, page, controls):
    before, separator, after = page.rpartition('</body>')
    if not separator:
        raise RuntimeError('The installed ttyd HTML has no body; cannot add upload controls.')
    path.write_text(before + controls + separator + after)
    path.chmod(0o600)
    return path


def builtin_page(executable):
    # Ask an isolated, authenticated loopback-only ttyd for its own version of
    # the page. No downloaded JavaScript or vendored third-party bundle is used.
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    credential = 'bootstrap:' + secrets.token_urlsafe(32)
    auth = base64.b64encode(credential.encode()).decode()
    request = urllib.request.Request(f'http://127.0.0.1:{port}/',
                                     headers={'Authorization': 'Basic ' + auth})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)
    process = subprocess.Popen([executable, '-i', '127.0.0.1', '-p', str(port),
                                '-c', credential, '/usr/bin/true'],
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        for _ in range(50):
            if process.poll() is not None:
                raise RuntimeError('Unable to read the installed ttyd page.')
            try:
                with opener.open(request, timeout=1) as response:
                    data = response.read()
                    if response.headers.get('Content-Encoding') == 'gzip':
                        data = gzip.decompress(data)
                    return data.decode()
            except (urllib.error.URLError, TimeoutError):
                time.sleep(0.1)
        raise RuntimeError('Timed out reading the installed ttyd page.')
    finally:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None
