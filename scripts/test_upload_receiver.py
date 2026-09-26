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
            self.assertEqual(events[0], {'type': 'ready', 'version': 1, 'resume': True})
            self.assertEqual([event['bytes'] for event in events if event['type'] == 'progress'],
                             [CHUNK_SIZE, 2 * CHUNK_SIZE, len(data)])
            saved = events[-1]
            self.assertEqual(saved['type'], 'saved')
            self.assertEqual(Path(saved['path']).read_bytes(), data)
            self.assertEqual(Path(saved['path']).stat().st_mode & 0o777, 0o600)
            self.assertEqual(list(Path(saved['path']).parent.iterdir()), [Path(saved['path'])])

    def resume(self, parent, data, size, identifier='a'*32, name='file.bin', receipt=False):
        source = io.BytesIO(json.dumps({'version': 2, 'id': identifier, 'name': name, 'size': size}).encode()+b'\n'+data+(json.dumps({'complete': identifier}).encode()+b'\n' if receipt else b''))
        sink = io.BytesIO()
        receive_file(source, sink, parent)
        return [json.loads(line) for line in sink.getvalue().splitlines()]

    def test_resume_preserves_confirmed_bytes_and_lost_final_ack(self):
        with tempfile.TemporaryDirectory() as folder:
            parent = Path(folder)
            with self.assertRaises(EOFError):
                self.resume(parent, b'first', 11)
            events = self.resume(parent, b'second', 11, receipt=True)
            self.assertEqual(events[1]['offset'], 5)
            self.assertEqual(Path(events[-1]['path']).read_bytes(), b'firstsecond')
            replay = self.resume(parent, b'', 11, receipt=True)
            self.assertEqual(replay[1]['offset'], 11)
            self.assertEqual(replay[-1], events[-1])

    def test_lost_completion_receipt_returns_original_completed_file(self):
        with tempfile.TemporaryDirectory() as folder:
            parent = Path(folder)
            with self.assertRaises(EOFError):
                self.resume(parent, b'done', 4)
            events = self.resume(parent, b'', 4, receipt=True)
            self.assertEqual(events[1]['offset'], 4)
            self.assertEqual(Path(events[-1]['path']).read_bytes(), b'done')
            self.assertEqual(len(list(parent.glob('upload-*'))), 1)

    def test_resume_rejects_changed_metadata_and_unsafe_ids(self):
        with tempfile.TemporaryDirectory() as folder:
            parent = Path(folder)
            with self.assertRaises(EOFError):
                self.resume(parent, b'part', 10)
            for kwargs in [{'size': 12}, {'name': 'other.bin'}, {'identifier': '../escape'}]:
                with self.assertRaises(ValueError):
                    self.resume(parent, b'', **({'size': 10} | kwargs))
            self.assertEqual((parent/'.transfers'/('a'*32)/'data').read_bytes(), b'part')

    def test_concurrent_resume_is_rejected_without_modifying_data(self):
        import fcntl
        with tempfile.TemporaryDirectory() as folder:
            parent = Path(folder)
            with self.assertRaises(EOFError):
                self.resume(parent, b'part', 10)
            state = parent/'.transfers'/('a'*32)
            with (state/'lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                events = self.resume(parent, b'rest', 10)
                self.assertTrue(events[-1]['retryable'])
                self.assertEqual((state/'data').read_bytes(), b'part')

    def test_expiry_keeps_completed_files(self):
        import os
        from upload_receiver import expire_transfers
        with tempfile.TemporaryDirectory() as folder:
            parent = Path(folder)
            saved = Path(self.resume(parent, b'done', 4, receipt=True)[-1]['path'])
            state = parent/'.transfers'/('a'*32)
            os.utime(state, (1, 1))
            expire_transfers(parent/'.transfers')
            self.assertFalse(state.exists())
            self.assertEqual(saved.read_bytes(), b'done')

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
