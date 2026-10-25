import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCALE, TIMEZONE, USER_AGENT, VIEWPORT } from './browser-config.mjs';
import { createFixtureServer } from './fixture-server.mjs';
import { listProcesses } from './metrics.mjs';
import { detectEnvironment, runIteration } from './runner.mjs';
import { SCENARIOS } from './workflow.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function descendants(processes, rootPid) {
  const result = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of processes.values()) {
      if (result.has(entry.ppid) && !result.has(entry.pid)) {
        result.add(entry.pid);
        changed = true;
      }
    }
  }
  return result;
}

async function startControlChrome(chromePath) {
  const directory = await mkdtemp(path.join(PROJECT_ROOT, 'results', '.verify-control-'));
  const child = spawn(chromePath, [
    '--headless=new',
    '--disable-background-networking',
    '--disable-component-update',
    '--no-first-run',
    '--no-startup-window',
    '--remote-debugging-port=0',
    `--user-data-dir=${directory}`,
  ], { stdio: 'ignore' });
  const control = { pid: child.pid, directory, ownedPids: new Set([child.pid]) };
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const processes = await listProcesses();
    const root = processes.get(child.pid);
    if (root && path.resolve(root.command) === path.resolve(chromePath)) {
      for (const pid of descendants(processes, child.pid)) control.ownedPids.add(pid);
      return control;
    }
    if (child.exitCode !== null) break;
    await sleep(25);
  }
  await stopControlChrome(control);
  throw new Error('Control Chrome did not start');
}

async function stopControlChrome(control) {
  if (!control) return;
  const before = await listProcesses();
  for (const pid of descendants(before, control.pid)) control.ownedPids.add(pid);
  try {
    process.kill(control.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  const deadline = performance.now() + 5000;
  let live = [];
  while (performance.now() < deadline) {
    const processes = await listProcesses();
    live = [...control.ownedPids].filter((pid) => processes.has(pid));
    if (live.length === 0) break;
    await sleep(50);
  }
  if (live.length > 0) {
    for (const pid of live) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    const killDeadline = performance.now() + 1000;
    while (live.length > 0 && performance.now() < killDeadline) {
      const processes = await listProcesses();
      live = [...control.ownedPids].filter((pid) => processes.has(pid));
      if (live.length === 0) break;
      await sleep(50);
    }
  }
  if (live.length > 0) throw new Error(`Control Chrome left processes running: ${live.join(',')}`);
  await rm(control.directory, { recursive: true, force: true });
}

async function fetchFixture(baseUrl, runId, pathname) {
  const url = new URL(pathname, baseUrl);
  url.searchParams.set('runId', runId);
  return fetch(url, { cache: 'no-store' });
}

async function checkResetScope(baseUrl) {
  const first = `verify-reset-a-${randomUUID()}`;
  const second = `verify-reset-b-${randomUUID()}`;
  for (const runId of [first, second]) {
    assert.equal((await fetchFixture(baseUrl, runId, '/failure')).status, 503);
    assert.equal((await fetchFixture(baseUrl, runId, '/failure')).status, 503);
  }
  assert.equal((await fetchFixture(baseUrl, first, '/__reset')).status, 200);
  assert.equal((await fetchFixture(baseUrl, first, '/failure')).status, 503);
  assert.equal((await fetchFixture(baseUrl, second, '/failure')).status, 200);
}

async function main() {
  const { chromePath, versions } = await detectEnvironment();
  assert.equal(versions.libraries.playwright, '1.64.1');
  assert.equal(versions.libraries.puppeteer, '25.16.0');
  const fixture = await createFixtureServer();
  let control;
  const harnessRootPids = new Set();
  const results = new Map();

  try {
    control = await startControlChrome(chromePath);
    const firstBody = await (await fetchFixture(fixture.baseUrl, 'verify-static', '/basic')).text();
    const secondBody = await (await fetchFixture(fixture.baseUrl, 'verify-static', '/basic')).text();
    const slowBody = await (await fetchFixture(fixture.baseUrl, 'verify-slow', '/slow')).text();
    assert.equal(firstBody, secondBody);
    assert.equal(firstBody, slowBody);
    await checkResetScope(fixture.baseUrl);
    console.log('PASS deterministic static/slow routes and run-scoped reset/503 state');

    let executionOrder = 0;
    for (const library of ['playwright', 'puppeteer']) {
      for (const scenario of SCENARIOS) {
        executionOrder += 1;
        const runId = `verify-${randomUUID()}-${executionOrder}`;
        const { record, output } = await runIteration({
          baseUrl: fixture.baseUrl,
          runId,
          benchmarkId: 'verification',
          library,
          scenario,
          batch: 0,
          iteration: 1,
          measured: false,
          executionOrder,
          chromePath,
          versions,
          checkEnvironment: true,
        });
        for (const pid of record.processAttribution.rootPids) harnessRootPids.add(pid);
        assert.equal(record.success, true, `${library}/${scenario.name}: ${record.error}`);
        assert.equal(record.duplicates, 0);
        assert.match(record.outputHash, /^[a-f0-9]{64}$/);
        assert.equal(record.processAttribution.rootProcessCount, 1);
        assert.ok(record.processAttribution.baselineChromeCount >= 1, 'Control Chrome was not present in the baseline');
        assert.deepEqual(record.processAttribution.unrelatedChromePidsTracked, []);
        assert.equal(record.processAttribution.rootPids.includes(control.pid), false);
        assert.ok(record.processAttribution.chromeSampleCount > 0);
        assert.deepEqual(record.processAttribution.sampleErrors, []);
        assert.deepEqual(record.processAttribution.leftoverHarnessPids, []);
        assert.ok(record.peakSampledRssKiB > 0);
        assert.ok(record.peakChromeSampledRssKiB > 0);
        assert.deepEqual(record.details.environmentCheck, {
          userAgent: USER_AGENT,
          language: LOCALE,
          timezone: TIMEZONE,
          width: VIEWPORT.width,
          height: VIEWPORT.height,
          deviceScaleFactor: VIEWPORT.deviceScaleFactor,
        });
        results.set(`${library}/${scenario.name}`, { record, output });
        console.log(`PASS ${library}/${scenario.name} (${record.wallMs} ms, ${record.peakSampledRssKiB} KiB peak sampled RSS)`);
      }
    }

    for (const scenario of SCENARIOS) {
      const playwright = results.get(`playwright/${scenario.name}`);
      const puppeteer = results.get(`puppeteer/${scenario.name}`);
      assert.deepEqual(playwright.output, puppeteer.output, `${scenario.name} output differs`);
      assert.equal(playwright.record.outputHash, puppeteer.record.outputHash, `${scenario.name} hash differs`);
    }
    const basic = results.get('playwright/basic');
    for (const name of ['js', 'slow', 'session-create', 'failure-recovery', 'session-expiry-recovery', 'renderer-recovery']) {
      assert.equal(results.get(`playwright/${name}`).record.outputHash, basic.record.outputHash, `${name} normalized records differ from basic`);
    }

    for (const library of ['playwright', 'puppeteer']) {
      const failure = results.get(`${library}/failure-recovery`);
      assert.equal(failure.record.details.failureAttempts, 3);
      assert.deepEqual(fixture.inspect(failure.record.runId).failures, { primary: 3 });

      const reuse = results.get(`${library}/session-reuse`);
      assert.equal(reuse.record.details.visits, 3);
      assert.equal(fixture.inspect(reuse.record.runId).loginCount, 1);
      assert.equal(fixture.inspect(reuse.record.runId).protectedAllowed, 4);

      const expiry = results.get(`${library}/session-expiry-recovery`);
      assert.equal(expiry.record.details.expiredStatus, 401);
      assert.equal(expiry.record.details.sessionLogins, 2);
      const expiryState = fixture.inspect(expiry.record.runId);
      assert.equal(expiryState.loginCount, 2);
      assert.equal(expiryState.expirationCount, 1);
      assert.equal(expiryState.protectedDenied, 1);
      assert.equal(expiryState.protectedAllowed, 2);

      const renderer = results.get(`${library}/renderer-recovery`);
      assert.equal(renderer.record.details.rendererCrashed, true);
      assert.equal(renderer.record.details.recoveredWithNewPage, true);
      assert.equal(renderer.record.duplicates, 0);
    }
    console.log('PASS identical hashes, fake sessions/expiry, 503 recovery, CDP renderer recovery, and no duplicates');

    await stopControlChrome(control);
    control = null;
    await fixture.close();
    const processes = await listProcesses();
    const leftovers = [...harnessRootPids].filter((pid) => processes.has(pid));
    assert.deepEqual(leftovers, [], 'Harness Chrome roots remain after cleanup');
    console.log('PASS process attribution excluded control Chrome and left no harness Chrome roots');
  } finally {
    if (control) await stopControlChrome(control);
    if (fixture) await fixture.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
