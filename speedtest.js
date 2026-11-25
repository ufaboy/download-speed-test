#!/usr/bin/env node
'use strict';

const http = require('node:http');
const https = require('node:https');
const { parseArgs } = require('node:util');

const KB = 1024;
const MAX_REDIRECTS = 5;
const RETRY_DELAY_MS = 500;
const PROGRESS_INTERVAL_MS = 100;

const DEFAULTS = { count: 10, timeout: 30, retries: 2, unit: 'kb' };

const UNITS = {
  kb: { label: 'KB/s', speed: (bytes, ms) => bytes / KB / (ms / 1000) },
  mbit: { label: 'Mbit/s', speed: (bytes, ms) => (bytes * 8) / 1e6 / (ms / 1000) },
};

// Exit codes.
const EXIT_OK = 0;
const EXIT_FAILED = 1; // bad arguments, or every request failed
const EXIT_PARTIAL = 2; // some requests failed, at least one succeeded

const HELP = `Usage: node speedtest.js [options] <url>

Downloads <url> several times sequentially and reports the average request
time, total amount downloaded and download speed.

Options:
  -n, --count <n>        number of requests (default ${DEFAULTS.count})
  -t, --timeout <sec>    abort an attempt after this many seconds without any
                         data (default ${DEFAULTS.timeout})
  -r, --retries <n>      extra attempts per request after a retryable failure
                         (default ${DEFAULTS.retries})
  -u, --unit <unit>      speed unit: kb (KB/s, 1 KB = 1024 bytes) or
                         mbit (Mbit/s, 1 Mbit = 1,000,000 bits) (default ${DEFAULTS.unit})
      --json             print the result as JSON to stdout
  -h, --help             show this help

Example:
  node speedtest.js --count 5 --unit mbit https://proof.ovh.net/files/10Mb.dat`;

function fail(message) {
  console.error(message);
  console.error('Run with --help for usage.');
  process.exit(EXIT_FAILED);
}

function httpError(statusCode, statusMessage) {
  const err = new Error(`HTTP ${statusCode} ${statusMessage}`.trim());
  // Client errors will not fix themselves, except timeouts and rate limiting.
  err.retryable = statusCode >= 500 || statusCode === 408 || statusCode === 429;
  return err;
}

// Downloads `url` once. Resolves with the number of body bytes received as
// they arrived over the wire (compressed bodies are NOT decompressed).
// `onProgress(bytes, totalOrNull)` is called as data arrives.
function download(url, timeoutMs, onProgress, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, {
      headers: {
        'Cache-Control': 'no-cache',
        // Advertise compression like a browser would; bytes are counted as received.
        'Accept-Encoding': 'gzip, deflate, br',
        // Some servers reject requests that have no User-Agent.
        'User-Agent': 'download-speed-test/1.0 (Node.js)',
      },
    });

    // Idle timeout: fires if the socket gets no data for `timeoutMs`
    // (covers a stalled connect, a server that never answers, or a stuck body).
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timed out after ${timeoutMs / 1000} s without data`));
    });

    req.on('error', reject);

    req.on('response', (res) => {
      const { statusCode, headers } = res;

      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (redirectsLeft === 0) {
          const err = new Error(`too many redirects (more than ${MAX_REDIRECTS})`);
          err.retryable = false;
          reject(err);
          return;
        }
        resolve(download(new URL(headers.location, url), timeoutMs, onProgress, redirectsLeft - 1));
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        res.resume();
        reject(httpError(statusCode, res.statusMessage));
        return;
      }

      const length = Number(headers['content-length']);
      const total = Number.isFinite(length) && length > 0 ? length : null;
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        onProgress(bytes, total);
      });
      res.on('end', () => resolve(bytes));
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('response aborted by server')));
    });
  });
}

async function timedDownload(url, timeoutMs, onProgress) {
  const start = process.hrtime.bigint();
  const bytes = await download(url, timeoutMs, onProgress);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { bytes, ms };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs one logical request with retries. Only the successful attempt's bytes
// and time are reported; failed attempts are not counted.
async function runRequest(url, cfg, onProgress, onRetry) {
  let lastError;
  for (let attempt = 1; attempt <= cfg.retries + 1; attempt++) {
    try {
      const { bytes, ms } = await timedDownload(url, cfg.timeoutMs, onProgress);
      return { ok: true, bytes, ms, attempts: attempt };
    } catch (err) {
      lastError = err;
      const canRetry = err.retryable !== false && attempt <= cfg.retries;
      if (!canRetry) {
        return { ok: false, error: err.message, attempts: attempt };
      }
      const delay = RETRY_DELAY_MS * attempt;
      onRetry(attempt, err, delay);
      await sleep(delay);
    }
  }
  return { ok: false, error: lastError.message, attempts: cfg.retries + 1 };
}

// Single-line progress on stderr; only used when stderr is a terminal.
function createProgress(enabled) {
  if (!enabled) {
    return { update() {}, clear() {} };
  }
  let lastDraw = 0;
  let drawn = false;
  return {
    update(label, bytes, total) {
      const now = Date.now();
      if (now - lastDraw < PROGRESS_INTERVAL_MS) return;
      lastDraw = now;
      const done = (bytes / KB).toFixed(0);
      const text = total
        ? `${label}: ${done} / ${(total / KB).toFixed(0)} KB (${Math.floor((bytes / total) * 100)}%)`
        : `${label}: ${done} KB`;
      process.stderr.write(`\r${text}\x1b[K`);
      drawn = true;
    },
    clear() {
      if (drawn) process.stderr.write('\r\x1b[K');
      drawn = false;
    },
  };
}

function parseIntOption(name, raw, min) {
  if (!/^\d+$/.test(raw) || Number(raw) < min) {
    fail(`Invalid --${name}: ${raw} (expected an integer >= ${min})`);
  }
  return Number(raw);
}

function parseCli() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        count: { type: 'string', short: 'n' },
        timeout: { type: 'string', short: 't' },
        retries: { type: 'string', short: 'r' },
        unit: { type: 'string', short: 'u' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    fail(err.message);
  }

  const { values, positionals } = parsed;
  if (values.help) {
    console.log(HELP);
    process.exit(EXIT_OK);
  }

  if (positionals.length !== 1) {
    fail(positionals.length === 0 ? 'Missing URL.' : 'Expected exactly one URL.');
  }

  const rawUrl = positionals[0];
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    fail(`Invalid URL: ${rawUrl} (expected http:// or https://)`);
  }

  const count = values.count === undefined ? DEFAULTS.count : parseIntOption('count', values.count, 1);
  const retries = values.retries === undefined ? DEFAULTS.retries : parseIntOption('retries', values.retries, 0);

  const timeout = values.timeout === undefined ? DEFAULTS.timeout : Number(values.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    fail(`Invalid --timeout: ${values.timeout} (expected a positive number of seconds)`);
  }

  const unit = (values.unit ?? DEFAULTS.unit).toLowerCase();
  if (!UNITS[unit]) {
    fail(`Invalid --unit: ${values.unit} (expected one of: ${Object.keys(UNITS).join(', ')})`);
  }

  return { url, count, retries, timeoutMs: timeout * 1000, unit, json: Boolean(values.json) };
}

const round = (n, digits) => Number(n.toFixed(digits));

async function main() {
  const cfg = parseCli();
  const unit = UNITS[cfg.unit];
  const text = !cfg.json;
  const log = (line) => text && console.log(line);
  const progress = createProgress(text && process.stderr.isTTY);

  log(`URL:      ${cfg.url.href}`);
  log(
    `Requests: ${cfg.count} (sequential), timeout ${cfg.timeoutMs / 1000} s, ` +
      `retries ${cfg.retries}, unit ${unit.label}\n`
  );

  const results = [];
  for (let i = 1; i <= cfg.count; i++) {
    const label = `Request ${String(i).padStart(String(cfg.count).length)}`;
    const result = await runRequest(
      cfg.url,
      cfg,
      (bytes, total) => progress.update(label, bytes, total),
      (attempt, err, delay) => {
        progress.clear();
        if (text) {
          console.error(`${label}: attempt ${attempt} failed (${err.message}), retrying in ${delay / 1000} s`);
        }
      }
    );
    progress.clear();
    results.push({ request: i, ...result });

    const retried = result.attempts > 1 ? `, attempt ${result.attempts}` : '';
    if (result.ok) {
      log(
        `${label}: ${(result.bytes / KB).toFixed(1)} KB in ${result.ms.toFixed(0)} ms ` +
          `(${unit.speed(result.bytes, result.ms).toFixed(1)} ${unit.label}${retried})`
      );
    } else if (text) {
      console.error(`${label}: FAILED - ${result.error}${retried}`);
    }
  }

  const ok = results.filter((r) => r.ok);
  const totalBytes = ok.reduce((sum, r) => sum + r.bytes, 0);
  const totalMs = ok.reduce((sum, r) => sum + r.ms, 0);
  const avgMs = ok.length ? totalMs / ok.length : null;
  const speed = ok.length && totalMs > 0 ? unit.speed(totalBytes, totalMs) : null;

  if (cfg.json) {
    const output = {
      url: cfg.url.href,
      settings: {
        count: cfg.count,
        timeoutSeconds: cfg.timeoutMs / 1000,
        retries: cfg.retries,
        unit: unit.label,
      },
      requests: results.map((r) =>
        r.ok
          ? {
              request: r.request,
              ok: true,
              attempts: r.attempts,
              bytes: r.bytes,
              ms: round(r.ms, 1),
              speed: round(unit.speed(r.bytes, r.ms), 1),
            }
          : { request: r.request, ok: false, attempts: r.attempts, error: r.error }
      ),
      summary: {
        successful: ok.length,
        failed: results.length - ok.length,
        averageMs: avgMs === null ? null : round(avgMs, 1),
        totalBytes,
        speed: speed === null ? null : round(speed, 1),
        unit: unit.label,
      },
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    log('\nSummary');
    log(`  Successful requests:  ${ok.length} of ${results.length}`);
    if (ok.length) {
      log(`  Average request time: ${avgMs.toFixed(0)} ms`);
      log(`  Total downloaded:     ${(totalBytes / KB).toFixed(1)} KB (${totalBytes} bytes)`);
      log(`  Download speed:       ${speed.toFixed(1)} ${unit.label}`);
    } else {
      log('  No successful requests, speed cannot be measured.');
    }
  }

  if (ok.length === results.length) process.exitCode = EXIT_OK;
  else if (ok.length === 0) process.exitCode = EXIT_FAILED;
  else process.exitCode = EXIT_PARTIAL;
}

main();
