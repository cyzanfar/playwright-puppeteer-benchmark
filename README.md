# Playwright vs Puppeteer benchmark

This project compares Playwright 1.64.1 and Puppeteer 25.16.0 with the same installed Chrome, loopback fixtures, DOM extraction, and process lifecycle. It has no web service dependencies and uses no real credentials. The fixture server listens on `127.0.0.1` with port 0.

The approved full run has 12 scenarios, 3 batches, 50 measured iterations per library/scenario/batch, and 10 warmups per library/scenario. That is 3,600 measured records and 240 warmup records, 3,840 JSONL records in total.

## Environment

The recorded reference environment is:

- Node 22.22.0 and npm 10.9.4
- Python 3.14.5 for analysis, using only the standard library
- macOS arm64 on an Apple M1 Max with 64 GiB RAM
- `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, version 156.0.8078.47

`CHROME_PATH` can select another executable. Both drivers use the resolved path and the raw data records the version reported by that executable.

```bash
export CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

Playwright and Puppeteer are the only direct npm dependencies. Their versions are exact in `package.json` and `package-lock.json`. `.npmrc` disables Puppeteer and Playwright browser downloads. Set Playwright's skip variable as well when installing:

```bash
cd tools/benchmarks/playwright-puppeteer
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
```

No `playwright install`, `puppeteer browsers install`, or other browser download is needed.

## Verification

Run the built-in verification utility before collecting data:

```bash
npm run verify
```

Verification launches every scenario with both drivers and checks:

- identical normalized values and SHA-256 output hashes
- deterministic static, JavaScript, and slow routes
- run-scoped reset state, exactly two controlled 503 responses, and recovery on request 3
- fake login, cookies, protected records, session reuse, forced expiry, HTTP 401, and fresh login
- CDP `Page.crash` renderer recovery with a new page and no duplicate records
- the configured user agent, viewport, locale, and timezone in the real page
- Chrome root attribution while a separate control Chrome is running
- no live benchmark-owned Chrome roots or attributed helpers after cleanup

The renderer scenario crashes one renderer, not the whole browser. Verification is a Node script, not a test framework.

## Pilot

The default pilot runs one warmup and 5 measured iterations in one batch for every library and scenario:

```bash
npm run benchmark -- --pilot
npm run analyze -- --input results/pilot.jsonl --pilot --output-dir results/pilot-analysis
```

This produces 120 measured records and 24 warmups in `results/pilot.jsonl`. Pilot summaries go to `results/pilot-analysis/` and are not published.

Pilot sizes are configurable. For example:

```bash
npm run benchmark -- --pilot --iterations=2 --warmups=0 --batches=1
npm run analyze -- --input results/pilot.jsonl --pilot --iterations=2 --warmups=0 --batches=1 --output-dir results/pilot-analysis
```

A pilot replaces the previous complete `results/pilot.jsonl`. Inspect pilot failures, phase durations, memory samples, and counts before starting a full run. Do not change the workflow or timing policy to favor a library.

## Full run

Start the frozen full methodology explicitly:

```bash
npm run benchmark -- --full
```

The full mode rejects size overrides and refuses to overwrite an existing `results/raw.jsonl`. The runner writes to `results/raw.jsonl.partial` and renames the file only after all 3,840 records finish. `results/full-status.json` contains the current state, expected and completed counts, failures, and the latest execution position.

The order alternates the first library between paired iterations. Batch 2 reverses the scenario order and changes the library alternation phase; batch 3 reverses back. Every iteration launches a fresh browser, creates a context and page, performs the workflow, and closes in the opposite order. Warmups use batch 0 and remain in the raw data. They are excluded from measured statistics.

Failures and outliers stay in the JSONL. A completed run can contain failed records. Analysis counts them but excludes them from timing and memory percentiles.

## Analysis and rendering

```bash
npm run analyze
npm run render
```

Analysis rejects unknown scenarios, missing or extra runs, non-contiguous execution positions, duplicate run IDs, missing fields, inconsistent environment versions, invalid process attribution on successful runs, and inconsistent output hashes. It requires exactly 50 measured records in each of 3 batches and 10 warmups for every library/scenario.

Median and p95 use linear interpolation. Sort the values, calculate `rank = (n - 1) * p`, and interpolate between `floor(rank)` and `ceil(rank)`. Median uses `p = 0.5`; p95 uses `p = 0.95`. Values are rounded to three decimal places only when summaries are written.

Generated benchmark files:

- `results/raw.jsonl`
- `results/summary.csv`
- `results/summary.json`
- `results/results-table.html`

`npm run render` checks the raw file's SHA-256 and cross-checks CSV rows against the JSON summary. It then writes identical generated public files, without manually changing values:

- `site/assets/benchmarks/playwright-puppeteer/raw.jsonl`
- `site/assets/benchmarks/playwright-puppeteer/summary.csv`
- `site/assets/benchmarks/playwright-puppeteer/summary.json`
- `site/assets/benchmarks/playwright-puppeteer/results-table.html`

The HTML has a separate horizontally scrollable `benchmark-table` for each scenario. Scenarios are never combined into an aggregate score.

## Scenarios

| Scenario | Work performed |
| --- | --- |
| `basic` | Read six records from static HTML. |
| `js` | Read the same six records after a fixed 40 ms JavaScript rendering delay. |
| `slow` | Read static records after a deterministic 90 ms server delay. |
| `session-create` | Log in with fake credentials, receive an HTTP-only fake session cookie, and read protected records. |
| `session-reuse` | Log in once and read protected records on three visits in the same context. |
| `failure-recovery` | Receive two controlled 503 responses keyed by the unique run ID, then recover on the third request. |
| `session-expiry-recovery` | Expire a fake session, observe HTTP 401, log in again, and read protected records. |
| `renderer-recovery` | Crash the renderer through each library's supported CDP session API, create a new page, and read records once with no duplicates. |
| `concurrency-1` | Run one JavaScript-rendered page in the context. |
| `concurrency-4` | Run four JavaScript-rendered pages concurrently in the context. |
| `concurrency-8` | Run eight JavaScript-rendered pages concurrently in the context. |
| `concurrency-16` | Run sixteen JavaScript-rendered pages concurrently in the context. |

Every request has a unique run ID. `/__reset` resets only that run. Failure counters and fake sessions cannot leak into another iteration. Concurrency results are stored in task order, not completion order. Session reuse results are stored in visit order.

## Fairness and measurement

Both drivers ignore library-specific default Chrome arguments and receive the same explicit arguments, including headless mode and the DevTools pipe. Each uses a fresh temporary profile with the same lifecycle. Both navigate with `waitUntil: "load"`, wait for the sixth record row to be attached, and call the same DOM extraction function. Navigation, waits, and launch have the same 10-second limits.

A shared CDP setup disables the cache and sets the same user agent, 1280 by 900 viewport, device scale factor 1, `en-US` locale, and `UTC` timezone. Playwright uses `browser.newContext()` and `context.newCDPSession(page)`. Puppeteer uses `browser.createBrowserContext()` and `page.createCDPSession()`. These are the corresponding supported APIs, not different workload behavior.

`performance.now()` measures phases and wall time. Wall time includes the run-scoped reset, process monitor setup, launch, context/page creation, workflow, close, and process-exit checks. Recovery timing can overlap navigation and extraction timing, so individual workflow phase values are not intended to sum to wall time.

Each JSONL record includes the run ID, library, scenario, batch, iteration, concurrency, execution order, library/Node/Chrome/OS/hardware versions, phase durations, wall time, success, output hash, failure category, duplicate count, peak sampled RSS, process attribution, timestamp, and error. Object keys are sorted before the extracted output is hashed with SHA-256.

## RSS and process attribution

`src/metrics.mjs` runs `ps` and schedules sampling every 50 ms. If a sample is still running, the next one does not overlap it. Before launch it records existing processes. After launch it accepts only a new process that has the configured Chrome executable and is directly parented to the benchmark's Node process. It never uses Playwright's undocumented `browser.process()` and never adopts existing Chrome processes.

Samples sum the Node driver and the launched Chrome root's descendants at the same instant. The reported peak is the largest aggregate sample for that iteration. Summary statistics describe the distribution of those per-iteration peaks in KiB.

RSS has important limits:

- It is not unique physical memory or PSS. Shared pages can be counted in multiple processes, so the sum can overstate memory.
- A 50 ms sampler can miss shorter spikes. Chrome startup before root discovery is not fully sampled.
- The Node process is reused across iterations, while browsers are fresh. Node and Chrome peak values are recorded separately as well as together.
- Process sampling itself costs time. The same policy applies to both libraries and its cost is included in wall time.
- Operating system crashpad handlers can be shared. They are not counted as leftovers or forcibly killed unless the normal process lifecycle owns them; the cleanup code deliberately excludes `chrome_crashpad_handler`.

## Cleanup and interrupted runs

Page, context, browser, and server cleanup run in `finally` blocks. The runner calls `browser.close()` and allows 250 ms for it to finish. If the owned Chrome tree keeps it stalled, the runner allows 100 ms for orphaned helpers, then signals only benchmark-owned Chrome processes. SIGTERM has 250 ms before SIGKILL. It checks executable paths and baseline PIDs before signaling and never uses `pkill` or kills the user's other Chrome windows.

Chrome 156 can leave helpers holding the DevTools pipe after a graceful close request. `details.browserCloseForced` records every use of this cleanup path, and the summaries report forced-cleanup counts. This policy is identical for both drivers.

If a run is interrupted, do not append to or repair its partial JSONL. Inspect the state, stop the old benchmark process, and explicitly discard the incomplete file before rerunning:

```bash
rm results/raw.jsonl.partial
npm run benchmark -- --full
```

Use `results/pilot.jsonl.partial` instead when discarding an interrupted pilot. A complete `raw.jsonl` is never overwritten. Run `npm run verify` after an interrupted run to check the process lifecycle again.

## Reproduce the published results

On the reference environment, the complete command sequence is:

```bash
export CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
npm run verify
npm run benchmark -- --pilot
npm run analyze -- --input results/pilot.jsonl --pilot --output-dir results/pilot-analysis
npm run benchmark -- --full
npm run analyze
npm run render
```

If any methodology code changes after a run starts, discard its incomplete data and start over. Never splice old and new records or edit figures in generated files.

The project is licensed under MIT. See `LICENSE`.
