# Upload validation — September 26, 2026

The worker uploader starts every selected file immediately. Each file has its own
Web Worker, authenticated connection, saved offset, cancellation, and retry state.
The browser UI receives throttled progress updates rather than processing file
bytes and socket traffic.

## Throughput

Measured with headless Chromium on the hosting Mac, using random synthetic files
of 9, 140, 151, 144, and 75 MiB (519 MiB per batch). File generation and hashing
were excluded from these timings. Every completed file was checked with SHA-256.
The public tests traversed a real Cloudflare Quick Tunnel; the local test used
the same receiver over loopback. Public connections sometimes dropped naturally,
and those retries are included in the timings.

| Implementation | Route | Simultaneous files | Seconds | MiB/s |
| --- | --- | ---: | ---: | ---: |
| Previous version (`16415e4`) | Public tunnel | 3 | 90.0 | 5.77 |
| Background workers | Public tunnel | 5 | 90.6 | 5.73 |
| Background workers | Loopback | 5 | 38.0 | 13.64 |

This comparison did not demonstrate a public-network speed improvement. It shows
that the receiver can run faster locally than through this tunnel. Removing the
queue and moving transfers to workers does not increase the connection's available
bandwidth; results depend on the host, network, tunnel, and selected files.

## Recovery and UI behavior

Two further 519 MiB public batches completed in 98.0 and 97.2 seconds (5.30 and
5.34 MiB/s). Each batch deliberately interrupted transfers 24 times, including
22 interruptions on one file, and discarded one final completion response.
All ten files matched their SHA-256 hashes. Transfers resumed saved bytes and
all workers terminated after completion. Files that keep making saved progress
continue retrying; they no longer fail solely because they reach twenty reconnects.

A separate public test started twelve files together (181 MiB), confirmed twelve
open upload connections, and restarted only its isolated receiver mid-transfer.
All twelve files resumed and matched their hashes, finishing in 36.3 seconds.

The local browser integration test also verified:

- An upload finished saving its exact bytes while the UI thread was blocked for
  four seconds.
- A transfer with no saved progress stopped after five failed attempts.
- Per-file progress, cancellation, retry, empty files, Unicode names, and duplicate
  filenames worked independently.
- Saved paths were inserted once, without clearing the draft or sending Enter;
  insertion failure retained paths for retry without reuploading.
- Completed rows survived reopening, and successful uploads closed the dialog.

All 45 Python regression tests and the terminal interaction browser suite passed.
The latter checks selection, copying, multiline input, links, scrolling, and the
steady cursor.

## Reproduce

Install Playwright separately and set `PLAYWRIGHT_MODULE` if it is outside the
repository. Use a managed terminal state directory; tests load its credentials
without printing them. Only synthetic files are uploaded and cleaned afterward.
No commands or uploaded paths are sent into the live terminal.

```bash
UPLOAD_TEST_ROUNDS=2 UPLOAD_TEST_DROPS=22 \
  node scripts/smoke_test_upload_tunnel.cjs /path/to/terminal-state
node scripts/smoke_test_upload.cjs
node scripts/smoke_test_selection.cjs
python3 -m unittest discover -s scripts -p 'test_*.py'
```

For timing without deliberately dropped connections, set `UPLOAD_TEST_FAULTS=0`.
`UPLOAD_TEST_LOCAL=1` selects loopback. `UPLOAD_TEST_SIZES` accepts a JSON array of
file sizes in MiB; all files start together by default. Receiver restart tests
require an isolated session whose name starts with `sbt-resume-validation`.
