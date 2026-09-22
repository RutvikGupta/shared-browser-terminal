"""Install the official ble.sh prebuilt release locally, without changing shell startup files."""

import argparse
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

URL = 'https://github.com/akinomyoga/ble.sh/releases/download/nightly/ble-nightly.tar.xz'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--replace', action='store_true', help='Replace an existing ble.sh installation')
    args = parser.parse_args()
    if sys.version_info < (3, 12):
        parser.error('Python 3.12 or newer is required for safe archive extraction')
    prefix = Path.home() / '.local/share'
    if (prefix / 'blesh/ble.sh').exists() and not args.replace:
        print('ble.sh is already installed. Use --replace to update it.')
        return
    with tempfile.TemporaryDirectory(prefix='shared-terminal-blesh-') as name:
        work = Path(name)
        archive = work / 'ble-nightly.tar.xz'
        print('Downloading the official ble.sh nightly release...')
        with urllib.request.urlopen(URL, timeout=60) as response:
            archive.write_bytes(response.read())
        with tarfile.open(archive) as bundle:
            bundle.extractall(work, filter='data')
        subprocess.run(['/bin/bash', str(work / 'ble-nightly/ble.sh'), '--install', str(prefix)], check=True)
    print('Installed ble.sh. Global shell startup files were not changed.')


if __name__ == '__main__':
    main()
