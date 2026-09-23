"""Connection routing must not inject upload commands into a running agent."""

import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from terminal_connection import connection_command, completed_paths


class ConnectionTests(unittest.TestCase):
    def test_normal_connection_attaches_exact_session(self):
        self.assertEqual(connection_command(['example']), ['tmux', 'attach', '-t', '=example'])

    def test_stream_upload_uses_only_the_fixed_receiver(self):
        result = connection_command(['example', 'upload-stream'])
        self.assertEqual(Path(result[1]).name, 'upload_receiver.py')
        self.assertEqual(len(result), 2)
        with self.assertRaises(ValueError):
            connection_command(['example', 'upload-stream', '/custom/destination'])

    def test_upload_runs_receiver_separately_in_fixed_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch('terminal_connection.Path.home', return_value=Path(folder)), \
                    patch('terminal_connection.sys.stdin', io.StringIO('\n')), \
                    patch('terminal_connection.sys.stdout', io.StringIO()):
                result = connection_command(['example', 'upload'])
            self.assertEqual(result[0], 'trz')
            self.assertEqual(Path(result[1]).parent, Path(folder) / 'Downloads/terminal-uploads')
            self.assertTrue(Path(result[1]).is_dir())
            self.assertNotIn('--overwrite', result)

    def test_url_arguments_cannot_select_a_command_or_destination(self):
        for args in [[], ['example', 'bash'], ['example', 'upload', '/tmp/elsewhere']]:
            with self.assertRaises(ValueError):
                connection_command(args)

    def test_only_confirmed_complete_files_produce_paths(self):
        with tempfile.TemporaryDirectory() as folder:
            destination = Path(folder)
            a = destination / "a 'quoted' file.txt"
            b = destination / 'résumé.pdf'
            a.write_text('first')
            single = ('\033[u\033[0JSaved 1 file/directory to ' + folder + '\r\n- name').encode()
            self.assertEqual(completed_paths(destination, single, 0), [str(a)])
            b.write_text('second')
            summary = ('\033[u\033[0JSaved 2 files/directories to ' + folder + '\r\n- names').encode()
            self.assertEqual(completed_paths(destination, summary, 0), [str(a), str(b)])
            self.assertEqual(completed_paths(destination, summary, 1), [])
            self.assertEqual(completed_paths(destination, b'Cancelled', 0), [])
            self.assertEqual(completed_paths(destination, b'partial transfer failed', 0), [])
            a.unlink()
            self.assertEqual(completed_paths(destination, summary, 0), [])

    def test_success_for_another_directory_does_not_complete_upload(self):
        with tempfile.TemporaryDirectory() as folder:
            destination = Path(folder)
            (destination / 'one.txt').touch()
            self.assertEqual(completed_paths(destination, b'\033[u\033[0JSaved 1 file/directory to /another/upload\r\n', 0), [])


if __name__ == '__main__':
    unittest.main()
