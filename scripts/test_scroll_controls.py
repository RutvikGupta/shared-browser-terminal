import unittest
from unittest.mock import patch, call

from scroll_controls import control, agent_owns_screen


class ScrollControlsTests(unittest.TestCase):
    def state(self, mode='copy-mode'):
        return {'type': 'state', 'pane': '%2', 'history': 100, 'offset': 40, 'mode': mode, 'height': 30}

    def test_bottom_cancels_copy_mode_without_sending_escape(self):
        with patch('scroll_controls.snapshot', return_value=self.state()), patch('scroll_controls.tmux') as tmux:
            control('test', {'action': 'bottom', 'pane': '%2'})
        tmux.assert_called_once_with('send-keys', '-X', '-t', '%2', 'cancel')

    def test_bottom_does_not_touch_a_running_program_or_other_mode(self):
        for mode in ['', 'tree-mode']:
            with patch('scroll_controls.snapshot', return_value=self.state(mode)), patch('scroll_controls.tmux') as tmux:
                control('test', {'action': 'bottom', 'pane': '%2'})
                tmux.assert_not_called()

    def test_changed_pane_invalidates_old_gesture(self):
        with patch('scroll_controls.snapshot', return_value=self.state()), patch('scroll_controls.tmux') as tmux:
            control('test', {'action': 'scroll', 'pane': '%99', 'position': 0})
            tmux.assert_not_called()

    def test_scroll_only_uses_copy_mode_commands(self):
        with patch('scroll_controls.snapshot', return_value=self.state('')), patch('scroll_controls.tmux') as tmux:
            control('test', {'action': 'scroll', 'pane': '%2', 'position': 25})
        self.assertEqual(tmux.call_args_list, [call('copy-mode', '-t', '%2'),
            call('send-keys', '-X', '-t', '%2', 'history-bottom'),
            call('send-keys', '-X', '-N', '75', '-t', '%2', 'scroll-up')])

    def test_unsupported_actions_and_noninteger_offsets_rejected(self):
        with patch('scroll_controls.snapshot', return_value=self.state()), patch('scroll_controls.tmux') as tmux:
            for request in [{'action': 'kill-session'}, {'action': 'scroll', 'pane': '%2', 'position': '0; kill-session'}]:
                with self.assertRaises(ValueError):
                    control('test', request)
            tmux.assert_not_called()


class SelectionCaptureTests(unittest.TestCase):
    def test_capture_returns_joined_viewport_without_sending_keys(self):
        state = {'type': 'state', 'pane': '%2', 'history': 100, 'offset': 40, 'mode': 'copy-mode', 'height': 30}
        with patch('scroll_controls.snapshot', return_value=state.copy()), patch('scroll_controls.tmux', side_effect=['144', 'long wrapped line\nnext line\n', '0 0']) as tmux:
            result = control('test', {'action': 'selection', 'pane': '%2'})
        self.assertEqual(result['selection'], {'width': 144, 'text': 'long wrapped line\nnext line\n', 'application': False})
        self.assertEqual(tmux.call_args_list, [call('display-message', '-p', '-t', '%2', '#{pane_width}'),
            call('capture-pane', '-p', '-J', '-t', '%2', '-S', '-40', '-E', '-11'),
            call('display-message', '-p', '-t', '%2', '#{alternate_on} #{mouse_any_flag}')])

    def test_capture_rejects_output_changes(self):
        before = {'pane': '%2', 'history': 100, 'offset': 40, 'mode': 'copy-mode', 'height': 30}
        after = dict(before, history=101)
        with patch('scroll_controls.snapshot', side_effect=[before, before, after]), patch('scroll_controls.tmux', side_effect=['144', 'text\n']):
            with self.assertRaises(ValueError):
                control('test', {'action': 'selection', 'pane': '%2'})

    def test_stale_pane_does_not_scroll_or_capture_another_program(self):
        with patch('scroll_controls.snapshot', return_value={'pane':'%3', 'mode':''}), patch('scroll_controls.tmux') as tmux:
            control('test', {'action':'selection', 'pane':'%2', 'position':20})
        tmux.assert_not_called()


class AgentBottomTests(unittest.TestCase):
    def test_latest_exits_copy_mode_then_jumps_in_codex(self):
        state = {'pane': '%2', 'mode': 'copy-mode'}
        with patch('scroll_controls.snapshot', return_value=state), patch('scroll_controls.agent_owns_screen', return_value=True), patch('scroll_controls.tmux') as tmux:
            control('test', {'action': 'latest', 'pane': '%2'})
        self.assertEqual(tmux.call_args_list, [call('send-keys', '-X', '-t', '%2', 'cancel'),
                                             call('send-keys', '-t', '%2', 'C-End')])

    def test_latest_does_not_send_keys_to_other_programs(self):
        with patch('scroll_controls.snapshot', return_value={'pane': '%2', 'mode': ''}), patch('scroll_controls.agent_owns_screen', return_value=False), patch('scroll_controls.tmux') as tmux:
            control('test', {'action': 'latest', 'pane': '%2'})
        tmux.assert_not_called()

    def test_input_preparation_never_sends_application_keys(self):
        with patch('scroll_controls.snapshot', return_value={'pane': '%2', 'mode': ''}), patch('scroll_controls.agent_owns_screen') as owns, patch('scroll_controls.tmux') as tmux:
            control('test', {'action': 'bottom', 'pane': '%2'})
        owns.assert_not_called()
        tmux.assert_not_called()

    def test_only_foreground_supported_agents_in_alternate_screen_match(self):
        for screen, processes, expected in [
            ('1\t/dev/ttys001', '2 2 /opt/bin/codex\n', True),
            ('1\t/dev/ttys001', '2 3 /opt/bin/codex\n3 3 /usr/bin/vim\n', False),
            ('1\t/dev/ttys001', '2 2 /usr/bin/node\n', False),
            ('0\t/dev/ttys001', '2 2 /opt/bin/codex\n', False),
            ('1\t/dev/ttys001', '2 2 claude\n', True),
            ('1\t/dev/ttys001', '2 3 claude\n3 3 /bin/bash\n', False),
            ('0\t/dev/ttys001', '2 2 claude\n', False),
        ]:
            with self.subTest(screen=screen, processes=processes), patch('scroll_controls.tmux', return_value=screen), patch('scroll_controls.subprocess.check_output', return_value=processes):
                self.assertEqual(agent_owns_screen('%2'), expected)
