import tempfile
from pathlib import Path
import unittest

from terminal_page import write_page


class TerminalPageTests(unittest.TestCase):
    def test_preserves_existing_bundle_and_adds_controls_inside_body(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'index.html'
            write_page(path, '<html><body><script>original()</script></body></html>', '<button>Upload</button>')
            self.assertEqual(path.read_text(), '<html><body><script>original()</script><button>Upload</button></body></html>')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_unrecognized_page_does_not_produce_a_broken_index(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'index.html'
            with self.assertRaises(RuntimeError):
                write_page(path, 'unexpected response', '<button>Upload</button>')
            self.assertFalse(path.exists())


if __name__ == '__main__':
    unittest.main()
