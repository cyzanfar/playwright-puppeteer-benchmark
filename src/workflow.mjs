import { FAKE_CREDENTIALS } from './fixture-server.mjs';

export const SCENARIOS = Object.freeze([
  { name: 'basic', concurrency: 1 },
  { name: 'js', concurrency: 1 },
  { name: 'slow', concurrency: 1 },
  { name: 'session-create', concurrency: 1 },
  { name: 'session-reuse', concurrency: 1 },
  { name: 'failure-recovery', concurrency: 1 },
  { name: 'session-expiry-recovery', concurrency: 1 },
  { name: 'renderer-recovery', concurrency: 1 },
  { name: 'concurrency-1', concurrency: 1, concurrentJs: true },
  { name: 'concurrency-4', concurrency: 4, concurrentJs: true },
  { name: 'concurrency-8', concurrency: 8, concurrentJs: true },
  { name: 'concurrency-16', concurrency: 16, concurrentJs: true },
]);

export function extractRecordsInPage() {
  return Array.from(document.querySelectorAll('#records tr')).map((row) => ({
    id: Number(row.querySelector('.id').textContent.trim()),
    name: row.querySelector('.name').textContent.trim(),
    category: row.querySelector('.category').textContent.trim(),
    value: Number(row.querySelector('.value').textContent.trim()),
    inStock: row.querySelector('.in-stock').textContent.trim() === 'true',
  }));
}

function duplicateCount(records) {
  const seen = new Set();
  let duplicates = 0;
  for (const record of records) {
    if (seen.has(record.id)) duplicates += 1;
    seen.add(record.id);
  }
  return duplicates;
}

function validateRecords(records) {
  if (!Array.isArray(records) || records.length !== 6) throw new Error(`Expected 6 records, received ${records?.length}`);
  for (const record of records) {
    if (!Number.isInteger(record.id) || typeof record.name !== 'string' || typeof record.category !== 'string' || !Number.isFinite(record.value) || typeof record.inStock !== 'boolean') {
      throw new Error('Extracted record does not match the normalized schema');
    }
  }
}

export async function executeWorkflow({ driver, context, page, baseUrl, runId, scenario }) {
  const phases = { navigationMs: 0, waitMs: 0, extractionMs: 0, recoveryMs: 0 };
  const details = {};

  function fixtureUrl(pathname, extra = {}) {
    const url = new URL(pathname, baseUrl);
    url.searchParams.set('runId', runId);
    for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, String(value));
    return url.href;
  }

  async function navigate(targetPage, url) {
    const started = performance.now();
    const status = await driver.goto(targetPage, url);
    phases.navigationMs += performance.now() - started;
    return status;
  }

  async function waitForRecords(targetPage) {
    const started = performance.now();
    await driver.waitForRecords(targetPage);
    phases.waitMs += performance.now() - started;
  }

  async function extract(targetPage) {
    const started = performance.now();
    const records = await driver.evaluate(targetPage, extractRecordsInPage);
    phases.extractionMs += performance.now() - started;
    validateRecords(records);
    return records;
  }

  async function loadRecords(targetPage, url) {
    const status = await navigate(targetPage, url);
    if (status !== 200) throw new Error(`Expected HTTP 200, received ${status} for ${url}`);
    await waitForRecords(targetPage);
    return extract(targetPage);
  }

  async function login(targetPage, shouldExtract = true) {
    const url = fixtureUrl('/session/login', FAKE_CREDENTIALS);
    const status = await navigate(targetPage, url);
    if (status !== 200) throw new Error(`Fake login did not reach protected records, received ${status}`);
    await waitForRecords(targetPage);
    return shouldExtract ? extract(targetPage) : null;
  }

  let output;
  let duplicates = 0;

  if (scenario.concurrentJs) {
    const tasks = Array.from({ length: scenario.concurrency }, (_, index) => (async () => {
      const taskPage = index === 0 ? page : await driver.newPage(context);
      try {
        const records = await loadRecords(taskPage, fixtureUrl('/js', { task: index }));
        duplicates += duplicateCount(records);
        return { task: index, records };
      } finally {
        if (index !== 0) await driver.closePage(taskPage);
      }
    })());
    output = { tasks: await Promise.all(tasks) };
    details.tasks = scenario.concurrency;
  } else if (scenario.name === 'basic' || scenario.name === 'js' || scenario.name === 'slow') {
    output = await loadRecords(page, fixtureUrl(`/${scenario.name}`));
    duplicates = duplicateCount(output);
  } else if (scenario.name === 'session-create') {
    output = await login(page);
    duplicates = duplicateCount(output);
  } else if (scenario.name === 'session-reuse') {
    await login(page, false);
    const visits = [];
    for (let index = 0; index < 3; index += 1) {
      const records = await loadRecords(page, fixtureUrl('/session/protected', { visit: index }));
      duplicates += duplicateCount(records);
      visits.push({ visit: index, records });
    }
    output = { visits };
    details.visits = visits.length;
  } else if (scenario.name === 'failure-recovery') {
    let attempts = 0;
    while (attempts < 4) {
      attempts += 1;
      const status = await navigate(page, fixtureUrl('/failure', { key: 'primary' }));
      if (status === 503) continue;
      if (status !== 200) throw new Error(`Unexpected controlled-failure status ${status}`);
      await waitForRecords(page);
      output = await extract(page);
      break;
    }
    if (attempts !== 3 || !output) throw new Error(`Controlled 503 recovery took ${attempts} attempts instead of 3`);
    details.failureAttempts = attempts;
    duplicates = duplicateCount(output);
  } else if (scenario.name === 'session-expiry-recovery') {
    await login(page, false);
    const recoveryStarted = performance.now();
    const expireStatus = await navigate(page, fixtureUrl('/session/expire'));
    if (expireStatus !== 200) throw new Error(`Session expiry endpoint returned ${expireStatus}`);
    const expiredStatus = await navigate(page, fixtureUrl('/session/protected'));
    if (expiredStatus !== 401) throw new Error(`Expired session returned ${expiredStatus} instead of 401`);
    output = await login(page);
    phases.recoveryMs += performance.now() - recoveryStarted;
    details.expiredStatus = expiredStatus;
    details.sessionLogins = 2;
    duplicates = duplicateCount(output);
  } else if (scenario.name === 'renderer-recovery') {
    const beforeStatus = await navigate(page, fixtureUrl('/basic', { phase: 'before-crash' }));
    if (beforeStatus !== 200) throw new Error(`Pre-crash navigation returned ${beforeStatus}`);
    await waitForRecords(page);
    const recoveryStarted = performance.now();
    await driver.crashPage(page);
    details.rendererCrashed = true;
    await driver.closePage(page);
    const recoveredPage = await driver.newPage(context);
    try {
      output = await loadRecords(recoveredPage, fixtureUrl('/basic', { phase: 'after-crash' }));
    } finally {
      await driver.closePage(recoveredPage);
    }
    phases.recoveryMs += performance.now() - recoveryStarted;
    details.recoveredWithNewPage = true;
    duplicates = duplicateCount(output);
  } else {
    throw new Error(`Unknown scenario ${scenario.name}`);
  }

  if (duplicates !== 0) throw new Error(`Workflow produced ${duplicates} duplicate records`);
  return { output, duplicates, details, phases };
}
