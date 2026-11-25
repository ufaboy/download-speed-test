# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project

A single-file Node.js CLI (`speedtest.js`) that downloads a URL several times (10 by default) sequentially and reports average request time, total bytes downloaded and download speed (KB/s by default, or Mbit/s). It supports retries, an inactivity timeout, JSON output and a terminal progress line.

## Layout

- `speedtest.js` - the whole program; entry point.
- `package.json` - metadata and the `npm start` script; no dependencies.
- `README.md` - user-facing docs (options, units, what is counted, timeout, retries, progress, JSON, exit codes).

## Rules

- Keep it dependency-free: use only Node.js built-ins (`node:http`, `node:https`, `node:util`). Target Node.js >= 18.3.
- Use `node:http`/`node:https`, not `fetch`: `fetch` decompresses bodies, and the script must count bytes as received over the wire (compressed bodies stay compressed).
- Requests must stay sequential, and each response body must be read to the end before the timer stops.
- The timeout is an inactivity timeout (`req.setTimeout`), not a total-duration limit, so slow but progressing large downloads are not cut off.
- Retries: only network errors, timeouts, HTTP 5xx, 408 and 429 are retryable (`err.retryable !== false`). Other 4xx and redirect loops fail immediately. Failed attempts' bytes and time are never counted.
- A failed request does not stop the run; the summary covers successful requests only. Exit codes: 0 all ok, 1 bad arguments or all failed, 2 partial.
- Units: 1 KB = 1024 bytes; 1 Mbit = 1,000,000 bits. Speed = total bytes / total time of successful requests.
- stdout carries the result only (text or JSON). Progress, retry and failure messages go to stderr; progress is drawn only when stderr is a TTY and `--json` is off.
- If you change units, the formula, what is counted, options, output or exit codes, update `README.md` in the same change.
- All code, comments, output and docs are in English.

## Testing

There is no test suite. Verify manually:

```bash
node speedtest.js https://proof.ovh.net/files/10Mb.dat          # 10 lines + summary, exit 0
node speedtest.js -n 3 -u mbit https://proof.ovh.net/files/10Mb.dat
node speedtest.js --json -n 2 https://proof.ovh.net/files/10Mb.dat
node speedtest.js                                               # "Missing URL", exit 1
node speedtest.js -n 0 https://example.com                      # "Invalid --count", exit 1
```

For edge cases, run a throwaway local `node:http` server with routes for: a gzip-encoded body (compressed size is counted), a 302 redirect, a redirect loop (fails, not retried), a 404 (not retried), a 500 (retried, then FAILED), a route that alternates 503/200 (retry succeeds; with `-r 0` gives a partial result, exit 2), a route that never responds (`-t 1`, timed out), and a slow route with `Content-Length` (progress line, visible only in a real terminal).

When the output format changes, refresh the sample output in `README.md` with a real run.
