"""Control the active pane's tmux history and agent transcript over authenticated ttyd."""

import json
from pathlib import Path
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
    if not isinstance(request, dict) or request.get('action') not in ('status', 'bottom', 'scroll', 'latest', 'selection'):
        raise ValueError('Unsupported scroll action')
    if request['action'] == 'status':
        return state
    # A window/pane switch invalidates gestures for the previously visible pane.
    if request.get('pane') != state['pane'] or state['mode'] not in ('', 'copy-mode'):
        return state
    pane = state['pane']
    if request['action'] in ('bottom', 'latest'):
        if state['mode'] == 'copy-mode':
            tmux('send-keys', '-X', '-t', pane, 'cancel')
        if request['action'] == 'latest' and agent_owns_screen(pane):
            tmux('send-keys', '-t', pane, 'C-End')
    elif request['action'] != 'selection' or 'position' in request:
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
    state = snapshot(session)
    if request['action'] == 'selection' and state['pane'] == pane and state['mode'] in ('', 'copy-mode'):
        width = int(tmux('display-message', '-p', '-t', pane, '#{pane_width}').strip())
        if not 1 <= width <= 1000 or not 1 <= state['height'] <= 500:
            raise ValueError('Terminal dimensions exceed selection limit')
        text = tmux('capture-pane', '-p', '-J', '-t', pane,
                    '-S', str(-state['offset']), '-E', str(state['height'] - 1 - state['offset']))
        if len(text) > 500000 or snapshot(session) != state:
            raise ValueError('Terminal changed during selection capture')
        application = tmux('display-message', '-p', '-t', pane, '#{alternate_on} #{mouse_any_flag}').strip() == '1 1'
        state['selection'] = {'text': text, 'width': width, 'application': application and state['mode'] == ''}
    return state


def agent_owns_screen(pane):
    # Ctrl+End works without mouse capture (including Codex fullscreen defaults).
    # Do not send application keys to shells, editors, or background agents.
    alternate, terminal = tmux('display-message', '-p', '-t', pane,
                                      '#{alternate_on}\t#{pane_tty}').strip().split('\t')
    if alternate != '1':
        return False
    processes = subprocess.check_output(
        ['ps', '-ww', '-t', terminal.removeprefix('/dev/'), '-o', 'pgid=,tpgid=,comm='],
        text=True, stderr=subprocess.DEVNULL, timeout=3)
    for line in processes.splitlines():
        fields = line.split(None, 2)
        if len(fields) == 3 and fields[0] == fields[1] and Path(fields[2]).name in ('codex', 'claude'):
            return True
    return False


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
