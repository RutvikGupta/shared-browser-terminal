import io
import json
from pathlib import Path
import tempfile
import unittest

from upload_receiver import CHUNK_SIZE, receive_file


class UploadReceiverTests(unittest.TestCase):
    def transfer(self, parent, name, data, size=None):
        request = {'version': 1, 'name': name, 'size': len(data) if size is None else size}
        source = io.BytesIO(json.dumps(request).encode() + b'\n' + data)
        sink = io.BytesIO()
        receive_file(source, sink, parent)
        return [json.loads(line) for line in sink.getvalue().splitlines()]

    def test_streams_binary_and_reports_confirmed_progress(self):
        with tempfile.TemporaryDirectory() as folder:
            parent = Path(folder)
            data = bytes(range(256)) * 700
            events = self.transfer(parent, "résumé ' report.bin", data)
            self.assertEqual(events[0], {'type': 'ready', 'version': 1})
            self.assertEqual([event['bytes'] for event in events if event['type'] == 'progress'],
                             [CHUNK_SIZE, 2 * CHUNK_SIZE, len(data)])
            saved = events[-1]
            self.assertEqual(saved['type'], 'saved')
            self.assertEqual(Path(saved['path']).read_bytes(), data)
            self.assertEqual(Path(saved['path']).stat().st_mode & 0o777, 0o600)
            self.assertEqual(list(Path(saved['path']).parent.iterdir()), [Path(saved['path'])])

    def test_empty_file_and_duplicate_names_get_distinct_paths(self):
        with tempfile.TemporaryDirectory() as folder:
            parent = Path(folder)
            first = self.transfer(parent, 'empty.txt', b'')[-1]['path']
            second = self.transfer(parent, 'empty.txt', b'')[-1]['path']
            self.assertNotEqual(first, second)
            self.assertEqual(Path(first).read_bytes(), b'')

    def test_incomplete_transfer_removes_partial_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            parent = Path(folder)
            with self.assertRaises(EOFError):
                self.transfer(parent, 'partial.bin', b'partial', 100)
            self.assertEqual(list(parent.iterdir()), [])

    def test_rejects_paths_controls_and_invalid_sizes_before_creating_files(self):
        with tempfile.TemporaryDirectory() as folder:
            parent = Path(folder)
            for name in ['../escape', '/absolute', 'a/b', 'a\\b', '.', '..', '', 'a\ncommand', '\x00']:
                with self.subTest(name=name), self.assertRaises(ValueError):
                    self.transfer(parent, name, b'')
            for size in [-1, True, 1.5, 2**53]:
                with self.subTest(size=size), self.assertRaises(ValueError):
                    self.transfer(parent, 'file', b'', size)
            self.assertEqual(list(parent.iterdir()), [])

    def test_header_is_bounded(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                receive_file(io.BytesIO(b'x' * 4097), io.BytesIO(), Path(folder))


if __name__ == '__main__':
    unittest.main()
