"""Connection routing must not inject upload commands into a running agent."""

import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from terminal_connection import connection_command


class ConnectionTests(unittest.TestCase):
    def test_normal_connection_attaches_exact_session(self):
        self.assertEqual(connection_command(['example']), ['tmux', 'attach', '-t', '=example'])

    def test_upload_runs_receiver_separately_in_fixed_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch('terminal_connection.Path.home', return_value=Path(folder)), \
                    patch('terminal_connection.sys.stdin', io.StringIO('\n')), \
                    patch('terminal_connection.sys.stdout', io.StringIO()):
                result = connection_command(['example', 'upload'])
            self.assertEqual(result, ['trz', str(Path(folder) / 'Downloads/terminal-uploads')])
            self.assertTrue(Path(result[1]).is_dir())
            self.assertNotIn('--overwrite', result)

    def test_url_arguments_cannot_select_a_command_or_destination(self):
        for args in [[], ['example', 'bash'], ['example', 'upload', '/tmp/elsewhere']]:
            with self.assertRaises(ValueError):
                connection_command(args)


if __name__ == '__main__':
    unittest.main()
