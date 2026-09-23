"""Select the shared terminal or a separate, fixed-destination upload receiver."""

import base64
import json
import os
import re
import subprocess
import signal
import tempfile
from pathlib import Path
import sys


def connection_command(args):
    if len(args) == 1:
        return ['tmux', 'attach', '-t', '=' + args[0]]
    if len(args) == 2 and args[1] == 'scroll-controls':
        return [sys.executable, str(Path(__file__).with_name('scroll_controls.py')), args[0]]
    if len(args) == 2 and args[1] == 'upload-stream':
        return [sys.executable, str(Path(__file__).with_name('upload_receiver.py'))]
    if len(args) == 2 and args[1] == 'upload':
        parent = Path.home() / 'Downloads/terminal-uploads'
        parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        print('Ready to upload. Click Choose files above.', flush=True)
        print('Files will be saved under: ' + str(parent), flush=True)
        # A click inside the upload frame supplies browser user activation before
        # trzsz opens its file picker. Never send commands to the shared agent.
        if not sys.stdin.readline():
            raise SystemExit(0)
        destination = Path(tempfile.mkdtemp(prefix='upload-', dir=parent))
        return ['trz', str(destination)]
    raise ValueError('Unsupported terminal connection mode')


def main():
    command = connection_command(sys.argv[1:])
    if command[0] == 'trz':
        receive_upload(command)
    else:
        os.execvp(command[0], command)


def receive_upload(command):
    # trz returns zero even for some cancellations/errors. Relay its output but
    # require its final success summary before publishing a completion receipt.
    def disconnected(signum, frame):
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGHUP, disconnected)
    process = subprocess.Popen(command, stdout=subprocess.PIPE)
    tail = bytearray()
    try:
        while chunk := process.stdout.read1(65536):
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
            tail.extend(chunk)
            del tail[:-1024 * 1024]
        code = process.wait()
        destination = Path(command[-1])
        paths = completed_paths(destination, bytes(tail), code)
        if paths:
            receipt = base64.b64encode(json.dumps({'paths': paths}).encode()).decode()
            print('\033]777;sbt-upload-complete;' + receipt + '\007', end='', flush=True)
        else:
            print('\r\nNo completed upload paths were inserted.', flush=True)
            print('\033]777;sbt-upload-failed\007', end='', flush=True)
        if not any(destination.iterdir()):
            destination.rmdir()
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        process.stdout.close()


def completed_paths(destination, output, returncode):
    if returncode != 0:
        return []
    # Match the receiver's success header, including our unique destination.
    pattern = (rb'\x1b\[u\x1b\[0JSaved ([1-9][0-9]*) files?/director(?:y|ies) to '
               + re.escape(os.fsencode(destination)) + rb'\r?\n')
    success = re.search(pattern, output)
    if not success:
        return []
    paths = sorted(path for path in destination.iterdir() if path.is_file() and not path.is_symlink())
    if len(paths) != int(success.group(1)):
        return []
    return [str(path) for path in paths]


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        raise SystemExit(str(error))
