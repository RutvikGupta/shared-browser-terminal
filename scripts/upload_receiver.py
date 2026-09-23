"""Receive one bounded-memory upload through an authenticated ttyd connection."""

import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import tty

CHUNK_SIZE = 64 * 1024


def main():
    def disconnected(signum, frame):
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGHUP, disconnected)
    signal.signal(signal.SIGTERM, disconnected)
    signal.signal(signal.SIGALRM, disconnected)
    tty.setraw(sys.stdin.fileno())
    signal.alarm(120)
    try:
        receive_file(sys.stdin.buffer, sys.stdout.buffer, Path.home() / 'Downloads/terminal-uploads',
                     heartbeat=lambda: signal.alarm(120))
    except (OSError, ValueError, EOFError) as error:
        emit(sys.stdout.buffer, {'type': 'error', 'message': str(error)})
    finally:
        signal.alarm(0)


def receive_file(source, sink, parent, heartbeat=lambda: None):
    emit(sink, {'type': 'ready', 'version': 1})
    header = source.readline(4097)
    if len(header) > 4096 or not header.endswith(b'\n'):
        raise ValueError('Invalid upload header')
    request = json.loads(header)
    name, size = validate_request(request)
    parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination = Path(tempfile.mkdtemp(prefix='upload-', dir=parent))
    partial = None
    saved = False
    try:
        descriptor, temporary = tempfile.mkstemp(prefix='.partial-', dir=destination)
        partial = Path(temporary)
        with os.fdopen(descriptor, 'wb') as output:
            emit(sink, {'type': 'accepted', 'size': size})
            received = 0
            while received < size:
                data = source.read(min(CHUNK_SIZE, size - received))
                if not data:
                    raise EOFError('Upload disconnected before all bytes arrived')
                output.write(data)
                output.flush()
                received += len(data)
                heartbeat()
                emit(sink, {'type': 'progress', 'bytes': received})
            os.fsync(output.fileno())
        target = destination / name
        # Publish only complete files, without overwriting an existing path.
        os.link(partial, target)
        partial.unlink()
        saved = True
        emit(sink, {'type': 'saved', 'bytes': received, 'path': str(target)})
    finally:
        if partial is not None:
            partial.unlink(missing_ok=True)
        if not saved:
            try:
                destination.rmdir()
            except OSError:
                pass


def validate_request(request):
    if not isinstance(request, dict) or request.get('version') != 1:
        raise ValueError('Unsupported upload protocol')
    name, size = request.get('name'), request.get('size')
    if (not isinstance(name, str) or not name or name in ('.', '..') or
            any(char in name for char in '/\\') or
            any(ord(char) < 32 or ord(char) == 127 for char in name)):
        raise ValueError('Upload name must be a filename without path separators or control characters')
    if type(size) is not int or not 0 <= size <= 2**53 - 1:
        raise ValueError('Invalid upload size')
    return name, size


def emit(sink, message):
    sink.write((json.dumps(message, ensure_ascii=True) + '\n').encode())
    sink.flush()


if __name__ == '__main__':
    main()
