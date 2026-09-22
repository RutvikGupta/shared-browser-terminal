"""Select the shared terminal or a separate, fixed-destination upload receiver."""

import os
from pathlib import Path
import sys


def connection_command(args):
    if len(args) == 1:
        return ['tmux', 'attach', '-t', '=' + args[0]]
    if len(args) == 2 and args[1] == 'upload':
        destination = Path.home() / 'Downloads/terminal-uploads'
        destination.mkdir(parents=True, exist_ok=True, mode=0o700)
        print('Ready to upload. Click Choose files above.', flush=True)
        print('Files will be saved in: ' + str(destination), flush=True)
        # A click inside the upload frame supplies browser user activation before
        # trzsz opens its file picker. Never send commands to the shared agent.
        if not sys.stdin.readline():
            raise SystemExit(0)
        return ['trz', str(destination)]
    raise ValueError('Unsupported terminal connection mode')


def main():
    command = connection_command(sys.argv[1:])
    os.execvp(command[0], command)


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        raise SystemExit(str(error))
