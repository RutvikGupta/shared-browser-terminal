import unittest
from unittest.mock import patch, call

from scroll_controls import control


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
