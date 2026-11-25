# download-speed-test

A Node.js console script that makes 10 sequential requests to a given URL, waits for each response to be fully received (the body is read to the last byte), and prints:

- the average request time, in ms;
- the total amount of data downloaded, in KB;
- the download speed, in **KB/s** by default (or Mbit/s with `--unit mbit`).

## Requirements

Node.js 18.3 or newer. No external dependencies, no `npm install` needed.

## Usage

```bash
git clone https://github.com/ufaboy/download-speed-test.git
cd download-speed-test
node speedtest.js [options] <url>
```

| Option | Default | Description |
| --- | --- | --- |
| `-n, --count <n>` | `10` | Number of requests (integer >= 1). |
| `-t, --timeout <sec>` | `30` | Abort an attempt after this many seconds without any data. |
| `-r, --retries <n>` | `2` | Extra attempts per request after a retryable failure (integer >= 0). |
| `-u, --unit <unit>` | `kb` | Speed unit: `kb` (KB/s) or `mbit` (Mbit/s). |
| `--json` | off | Print the result as JSON to stdout. |
| `-h, --help` | | Show help. |

Examples:

```bash
node speedtest.js https://proof.ovh.net/files/10Mb.dat
node speedtest.js -n 5 -u mbit https://proof.ovh.net/files/10Mb.dat
node speedtest.js --json --retries 0 https://proof.ovh.net/files/10Mb.dat > result.json
```

Or via npm:

```bash
npm start -- [options] <url>
```

## Units

- **KB (kilobyte) = 1024 bytes.** Sizes are always printed in KB.
- **KB/s** (default) = total KB of all successful requests / their total time in seconds.
- **Mbit/s** (`--unit mbit`) uses decimal network units: **1 Mbit = 1,000,000 bits** (125,000 bytes), the convention ISPs and speed tests use.
- Request time is measured from sending the request until the last byte of the response body arrives, so it includes DNS lookup, connection setup and TLS.

## What is counted

The script counts **response body bytes as they arrive over the network**. It sends `Accept-Encoding: gzip, deflate, br` like a browser does, and if the server compresses the response, the compressed bytes are counted; nothing is decompressed. HTTP headers are not counted. Redirects (up to 5) are followed; only the final response's body is counted.

Only **successful** requests go into the summary. For a request that needed retries, only its successful attempt's bytes and time are used.

## Timeout

Each attempt is aborted if **no data arrives for `--timeout` seconds**. This is an inactivity timeout, not a limit on the whole download: a large file that keeps streaming slowly will not be cut off, but a server that does not answer or stalls mid-response will be.

## Retries and failed requests

If an attempt fails, it is retried up to `--retries` times, waiting 0.5 s, 1 s, 1.5 s, ... between attempts. Retried failures:

- network errors and timeouts;
- HTTP 5xx, 408 (Request Timeout) and 429 (Too Many Requests).

Other HTTP 4xx errors (e.g. 403, 404) and redirect loops are not retried, since repeating them would not help.

A request that still fails is reported as `FAILED` and the run **continues** with the next request. The summary shows how many requests succeeded, and the averages are computed over successful requests only.

## Progress

While a request is downloading, a progress line (`Request 3: 4096 / 10240 KB (40%)`) is shown on stderr. It is drawn only when stderr is a terminal and `--json` is not used, so it never ends up in redirected output.

## Sample output

```
URL:      https://proof.ovh.net/files/10Mb.dat
Requests: 10 (sequential), timeout 30 s, retries 2, unit KB/s

Request  1: 10240.0 KB in 3364 ms (3043.7 KB/s)
Request  2: 10240.0 KB in 774 ms (13230.6 KB/s)
...
Request 10: 10240.0 KB in 1448 ms (7073.1 KB/s)

Summary
  Successful requests:  10 of 10
  Average request time: 2239 ms
  Total downloaded:     102400.0 KB (104857600 bytes)
  Download speed:       4573.5 KB/s
```

With failures and retries:

```
Request 1: attempt 1 failed (HTTP 503 Service Unavailable), retrying in 0.5 s
Request 1: 2.0 KB in 2 ms (966.2 KB/s, attempt 2)
Request 2: FAILED - HTTP 404 Not Found
```

## JSON output

With `--json`, only JSON is printed to stdout (no progress or retry messages):

```json
{
  "url": "https://proof.ovh.net/files/10Mb.dat",
  "settings": { "count": 10, "timeoutSeconds": 30, "retries": 2, "unit": "KB/s" },
  "requests": [
    { "request": 1, "ok": true, "attempts": 1, "bytes": 10485760, "ms": 3364.2, "speed": 3043.7 },
    { "request": 2, "ok": false, "attempts": 3, "error": "HTTP 503 Service Unavailable" }
  ],
  "summary": {
    "successful": 9, "failed": 1, "averageMs": 2239.1,
    "totalBytes": 94371840, "speed": 4573.5, "unit": "KB/s"
  }
}
```

`averageMs` and `speed` are `null` when no request succeeded.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | All requests succeeded. |
| `1` | Invalid arguments, or every request failed. |
| `2` | Some requests failed, at least one succeeded. |

Note: some servers (e.g. Wikimedia) may reject automated clients with HTTP 403; use a file host that allows plain downloads.
