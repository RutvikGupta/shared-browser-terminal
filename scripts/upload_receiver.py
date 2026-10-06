"""Receive one bounded-memory upload through an authenticated ttyd connection."""

import json
import fcntl
import re
import shutil
import time
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
    emit(sink, {'type': 'ready', 'version': 1, 'resume': True, 'folders': True})
    header = source.readline(4097)
    if len(header) > 4096 or not header.endswith(b'\n'):
        raise ValueError('Invalid upload header')
    request = json.loads(header)
    name, size = validate_request(request)
    if request['version'] in (2, 3):
        return receive_resumable(source, sink, parent, request, heartbeat)
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


def receive_resumable(source, sink, parent, request, heartbeat):
    name, size = validate_request(request)
    identifier = request.get('id')
    if not isinstance(identifier, str) or not re.fullmatch(r'[a-f0-9]{32}', identifier):
        raise ValueError('Invalid upload ID')
    transfers = parent / '.transfers'
    transfers.mkdir(parents=True, exist_ok=True, mode=0o700)
    expire_transfers(transfers)
    state = transfers / identifier
    state.mkdir(exist_ok=True, mode=0o700)
    with (state / 'lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            emit(sink, {'type': 'error', 'message': 'Upload is reconnecting.', 'retryable': True})
            return
        metadata = state / 'metadata.json'
        expected = {'name': name, 'size': size}
        if request['version'] == 3:
            expected.update(group=request['group'], relative=request['relative'], directory=request['directory'])
        if metadata.exists():
            if json.loads(metadata.read_text()) != expected:
                raise ValueError('Upload details do not match the saved transfer')
        else:
            metadata.write_text(json.dumps(expected))
        os.utime(state, None)
        destination = parent / ('upload-' + (request['group'] if request['version'] == 3 else identifier))
        target = folder_target(destination, request['relative']) if request['version'] == 3 else folder_target(destination, name)
        if request['version'] == 3 and request['directory']:
            target.mkdir(exist_ok=True, mode=0o700)
            if target.is_symlink() or not target.is_dir():
                raise ValueError('Upload destination is not a directory')
            emit(sink, {'type': 'accepted', 'size': 0, 'offset': 0})
            confirm_saved(source, sink, target, 0, identifier)
            return
        partial = state / 'data'
        # A lost final acknowledgement must return the same completed path.
        if target.exists():
            if not partial.exists() or not os.path.samefile(partial, target) or target.stat().st_size != size:
                raise ValueError('Upload destination already exists')
            emit(sink, {'type': 'accepted', 'size': size, 'offset': size})
            confirm_saved(source, sink, target, size, identifier)
            return
        descriptor = os.open(partial, os.O_RDWR | os.O_CREAT, 0o600)
        with os.fdopen(descriptor, 'r+b') as output:
            received = output.seek(0, os.SEEK_END)
            if received > size:
                raise ValueError('Saved upload exceeds expected size')
            emit(sink, {'type': 'accepted', 'size': size, 'offset': received})
            try:
                while received < size:
                    data = source.read(min(CHUNK_SIZE, size - received))
                    if not data:
                        raise EOFError('Upload disconnected before all bytes arrived')
                    output.write(data)
                    output.flush()
                    received += len(data)
                    heartbeat()
                    os.utime(state, None)
                    emit(sink, {'type': 'progress', 'bytes': received})
            finally:
                output.flush()
                os.fsync(output.fileno())
        os.link(partial, target)
        confirm_saved(source, sink, target, received, identifier)


def confirm_saved(source, sink, target, size, identifier):
    # Keep the PTY alive until ttyd has delivered the completion message.
    # Immediate exit can race ttyd's buffered output, especially on resume.
    emit(sink, {'type': 'saved', 'bytes': size, 'path': str(target)})
    receipt = source.readline(4097)
    if len(receipt) > 4096 or not receipt.endswith(b'\n') or json.loads(receipt) != {'complete': identifier}:
        raise EOFError('Waiting for upload completion acknowledgement')


def expire_transfers(transfers):
    # Only our private transfer cache expires; completed user files stay intact.
    cutoff = time.time() - 24 * 3600
    for state in transfers.iterdir():
        if not re.fullmatch(r'[a-f0-9]{32}', state.name) or state.stat().st_mtime >= cutoff:
            continue
        try:
            with (state / 'lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                if state.stat().st_mtime < cutoff:
                    shutil.rmtree(state)
                    try:
                        (transfers.parent / ('upload-' + state.name)).rmdir()
                    except OSError:
                        pass
        except (FileNotFoundError, BlockingIOError):
            pass


def validate_request(request):
    if not isinstance(request, dict) or request.get('version') not in (1, 2, 3):
        raise ValueError('Unsupported upload protocol')
    name, size = request.get('name'), request.get('size')
    if (not isinstance(name, str) or not name or name in ('.', '..') or
            any(char in name for char in '/\\') or
            any(ord(char) < 32 or ord(char) == 127 for char in name)):
        raise ValueError('Upload name must be a filename without path separators or control characters')
    if type(size) is not int or not 0 <= size <= 2**53 - 1:
        raise ValueError('Invalid upload size')
    if request['version'] == 3:
        group, relative, directory = request.get('group'), request.get('relative'), request.get('directory')
        if not isinstance(group, str) or not re.fullmatch(r'[a-f0-9]{32}', group):
            raise ValueError('Invalid folder upload ID')
        if (not isinstance(relative, str) or not relative or
                any(part in ('', '.', '..') for part in relative.split('/')) or
                '\\' in relative or any(ord(char) < 32 or ord(char) == 127 for char in relative) or
                relative.split('/')[-1] != name):
            raise ValueError('Invalid relative upload path')
        if type(directory) is not bool or (directory and size != 0):
            raise ValueError('Invalid directory upload')
    return name, size


def folder_target(destination, relative):
    # The group ID isolates each selected folder; never follow an existing link
    # while building its nested directories or overwrite an existing file.
    destination.mkdir(exist_ok=True, mode=0o700)
    if destination.is_symlink() or not destination.is_dir():
        raise ValueError('Invalid upload directory')
    current = destination
    parts = relative.split('/')
    for part in parts[:-1]:
        current = current / part
        current.mkdir(exist_ok=True, mode=0o700)
        if current.is_symlink() or not current.is_dir():
            raise ValueError('Invalid upload directory')
    target = current / parts[-1]
    if target.is_symlink():
        raise ValueError('Invalid upload destination')
    return target


def emit(sink, message):
    sink.write((json.dumps(message, ensure_ascii=True) + '\n').encode())
    sink.flush()


if __name__ == '__main__':
    main()
