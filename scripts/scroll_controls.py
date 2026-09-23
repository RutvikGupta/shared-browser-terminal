"""Control only the active pane's tmux scrollback over authenticated ttyd."""

import json
import subprocess
import sys
import tty


def main():
    session = sys.argv[1]
    tty.setraw(sys.stdin.fileno())
    emit(snapshot(session))
    while line := sys.stdin.buffer.readline(4097):
        if len(line) > 4096 or not line.endswith(b'\n'):
            return
        try:
            emit(control(session, json.loads(line)))
        except (ValueError, subprocess.SubprocessError):
            emit({'type': 'error', 'message': 'Scroll controls could not reach the active pane.'})


def control(session, request):
    state = snapshot(session)
    if not isinstance(request, dict) or request.get('action') not in ('status', 'bottom', 'scroll'):
        raise ValueError('Unsupported scroll action')
    if request['action'] == 'status':
        return state
    # A window/pane switch invalidates gestures for the previously visible pane.
    if request.get('pane') != state['pane'] or state['mode'] not in ('', 'copy-mode'):
        return state
    pane = state['pane']
    if request['action'] == 'bottom':
        if state['mode'] == 'copy-mode':
            tmux('send-keys', '-X', '-t', pane, 'cancel')
    else:
        position = request.get('position')
        if type(position) is not int:
            raise ValueError('Invalid scroll position')
        offset = state['history'] - max(0, min(position, state['history']))
        if not offset:
            if state['mode'] == 'copy-mode':
                tmux('send-keys', '-X', '-t', pane, 'cancel')
        else:
            if state['mode'] != 'copy-mode':
                tmux('copy-mode', '-t', pane)
            tmux('send-keys', '-X', '-t', pane, 'history-bottom')
            tmux('send-keys', '-X', '-N', str(offset), '-t', pane, 'scroll-up')
    return snapshot(session)


def snapshot(session):
    fields = tmux('display-message', '-p', '-t', '=' + session + ':',
                  '#{pane_id}\t#{history_size}\t#{scroll_position}\t#{pane_mode}\t#{pane_height}').strip('\n').split('\t')
    pane, history, offset, mode, height = fields
    return {'type': 'state', 'pane': pane, 'history': int(history or 0),
            'offset': int(offset or 0), 'mode': mode, 'height': int(height)}


def tmux(*args):
    return subprocess.check_output(['tmux', *args], text=True, stderr=subprocess.DEVNULL, timeout=3)


def emit(message):
    print(json.dumps(message), flush=True)


if __name__ == '__main__':
    main()
