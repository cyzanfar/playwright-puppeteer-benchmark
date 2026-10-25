import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createPlaywrightDriver } from './drivers/playwright.mjs';
import { createPuppeteerDriver } from './drivers/puppeteer.mjs';
import { createFixtureServer } from './fixture-server.mjs';
import { ProcessMonitor } from './metrics.mjs';
import { executeWorkflow, SCENARIOS } from './workflow.mjs';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DEFAULT_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LIBRARIES = ['playwright', 'puppeteer'];
const FULL = Object.freeze({ warmups: 10, iterations: 50, batches: 3 });
const BROWSER_CLOSE_GRACE_MS = 250;
const ORPHANED_HELPER_GRACE_MS = 100;

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function outputHash(output) {
  return createHash('sha256').update(stableStringify(output)).digest('hex');
}

function errorText(error) {
  if (!error) return null;
  return `${error.name || 'Error'}: ${error.message || String(error)}`.slice(0, 4000);
}

function failureCategory(phase, error) {
  const message = String(error?.message || '').toLowerCase();
  if (message.includes('timeout') || message.includes('timed out')) return 'timeout';
  if (message.includes('duplicate')) return 'duplicates';
  if (message.includes('crashed') || message.includes('page.crash')) return 'renderer-recovery';
  if (['launch', 'context', 'page', 'close', 'process-monitor'].includes(phase)) return phase;
  if (phase === 'workflow') {
    if (message.includes('http') || message.includes('navigation') || message.includes('status')) return 'navigation';
    if (message.includes('record') || message.includes('schema')) return 'extraction';
    return 'workflow';
  }
  return 'unknown';
}

async function resetRun(baseUrl, runId) {
  const url = new URL('/__reset', baseUrl);
  url.searchParams.set('runId', runId);
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Fixture reset returned HTTP ${response.status}`);
  const body = await response.json();
  if (body.reset !== runId) throw new Error('Fixture reset returned the wrong runId');
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function closeBrowserWithMonitor(driver, browser, monitor) {
  await monitor.sample();
  let finished = false;
  let closeError = null;
  let forced = false;
  const closing = (async () => {
    try {
      await driver.closeBrowser(browser);
    } catch (error) {
      closeError = error;
    } finally {
      finished = true;
    }
  })();
  const deadline = performance.now() + BROWSER_CLOSE_GRACE_MS;

  while (!finished && performance.now() < deadline) {
    if (!await monitor.rootsAlive()) {
      await sleep(ORPHANED_HELPER_GRACE_MS);
      if (!finished) {
        forced = true;
        await monitor.terminateOwnedProcesses();
      }
      break;
    }
    await sleep(25);
  }
  if (!finished) {
    forced = true;
    await monitor.terminateOwnedProcesses();
  }
  await closing;
  return { closeError, forced };
}

export async function runIteration({
  baseUrl,
  runId,
  benchmarkId,
  library,
  scenario,
  batch,
  iteration,
  measured,
  executionOrder,
  chromePath,
  versions,
  checkEnvironment = false,
}) {
  const startedAt = new Date().toISOString();
  const driver = library === 'playwright' ? createPlaywrightDriver(chromePath) : createPuppeteerDriver(chromePath);
  const monitor = new ProcessMonitor({ chromePath });
  const phases = {
    launchMs: null,
    contextMs: null,
    pageMs: null,
    workflowMs: null,
    closeMs: null,
    navigationMs: null,
    waitMs: null,
    extractionMs: null,
    recoveryMs: null,
  };
  let browser;
  let context;
  let page;
  let output;
  let workflowResult;
  let environmentCheck;
  let primaryError = null;
  let primaryPhase = null;
  let cleanupError = null;
  let browserCloseForced = false;
  let currentPhase = 'reset';
  let monitorStarted = false;
  const wallStarted = performance.now();

  try {
    await resetRun(baseUrl, runId);
    currentPhase = 'process-monitor';
    await monitor.start();
    monitorStarted = true;

    currentPhase = 'launch';
    let phaseStarted = performance.now();
    browser = await driver.launch();
    phases.launchMs = performance.now() - phaseStarted;
    await monitor.discoverLaunchedRoots();

    currentPhase = 'context';
    phaseStarted = performance.now();
    context = await driver.newContext(browser);
    phases.contextMs = performance.now() - phaseStarted;

    currentPhase = 'page';
    phaseStarted = performance.now();
    page = await driver.newPage(context);
    phases.pageMs = performance.now() - phaseStarted;

    if (checkEnvironment) {
      environmentCheck = await driver.evaluate(page, () => ({
        userAgent: navigator.userAgent,
        language: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        width: window.innerWidth,
        height: window.innerHeight,
        deviceScaleFactor: window.devicePixelRatio,
      }));
    }

    currentPhase = 'workflow';
    phaseStarted = performance.now();
    workflowResult = await executeWorkflow({ driver, context, page, baseUrl, runId, scenario });
    phases.workflowMs = performance.now() - phaseStarted;
    Object.assign(phases, workflowResult.phases);
    output = workflowResult.output;
  } catch (error) {
    primaryError = error;
    primaryPhase = currentPhase;
  } finally {
    currentPhase = 'close';
    const closeStarted = performance.now();
    for (const close of [
      () => page && driver.closePage(page),
      () => context && driver.closeContext(context),
    ]) {
      try {
        await close();
      } catch (error) {
        cleanupError ||= error;
      }
    }
    if (browser) {
      try {
        const result = await closeBrowserWithMonitor(driver, browser, monitor);
        browserCloseForced = result.forced;
        cleanupError ||= result.closeError;
      } catch (error) {
        cleanupError ||= error;
      }
    }
    phases.closeMs = performance.now() - closeStarted;

    if (monitorStarted) {
      if (cleanupError) {
        try {
          browserCloseForced = true;
          await monitor.terminateOwnedProcesses();
        } catch (error) {
          cleanupError = new Error(`${errorText(cleanupError)}; owned-process cleanup: ${errorText(error)}`);
        }
      }
      try {
        await monitor.waitForOwnedExit();
      } catch (error) {
        cleanupError ||= error;
      }
      try {
        await monitor.stop();
      } catch (error) {
        cleanupError ||= error;
      }
    }
  }

  const processReport = monitor.report();
  const combinedError = primaryError || cleanupError;
  const processFailure = Boolean(browser && (!processReport.attributionOk || processReport.leftoverHarnessPids.length > 0));
  const success = !combinedError && output !== undefined && !processFailure;
  let error = errorText(combinedError);
  if (processFailure) {
    const detail = `Process attribution failed: roots=${processReport.rootProcessCount}, chromeSamples=${processReport.chromeSampleCount}, leftovers=${processReport.leftoverHarnessPids.join(',')}, sampleErrors=${processReport.sampleErrors.join(';')}`;
    error = error ? `${error}; ${detail}` : detail;
  }

  const record = {
    runId,
    benchmarkId,
    library,
    libraryVersion: versions.libraries[library],
    scenario: scenario.name,
    batch,
    iteration,
    concurrency: scenario.concurrency,
    measured,
    executionOrder,
    nodeVersion: versions.node,
    chromeVersion: versions.chrome,
    osVersion: versions.os,
    hardware: versions.hardware,
    platform: `${process.platform}-${process.arch}`,
    phases: Object.fromEntries(Object.entries(phases).map(([key, value]) => [key, round(value)])),
    wallMs: round(performance.now() - wallStarted),
    success,
    outputHash: output === undefined ? null : outputHash(output),
    failureCategory: success ? null : failureCategory(primaryError ? primaryPhase : currentPhase, combinedError),
    duplicates: workflowResult?.duplicates ?? 0,
    peakSampledRssKiB: processReport.peakSampledRssKiB,
    peakChromeSampledRssKiB: processReport.peakChromeSampledRssKiB,
    peakNodeSampledRssKiB: processReport.peakNodeSampledRssKiB,
    processAttribution: processReport,
    details: { ...(workflowResult?.details || {}), browserCloseForced, ...(environmentCheck ? { environmentCheck } : {}) },
    timestamp: startedAt,
    error,
  };
  return { record, output };
}

async function packageVersion(name) {
  const packageJson = JSON.parse(await readFile(path.join(PROJECT_ROOT, 'node_modules', name, 'package.json'), 'utf8'));
  return packageJson.version;
}

export async function detectEnvironment(chromePath = process.env.CHROME_PATH || DEFAULT_CHROME_PATH) {
  const resolvedChrome = path.resolve(chromePath);
  await access(resolvedChrome, (await import('node:fs')).constants.X_OK);
  const [{ stdout: chromeStdout }, { stdout: macVersion }, { stdout: model }, { stdout: memory }, { stdout: cpu }] = await Promise.all([
    execFileAsync(resolvedChrome, ['--version']),
    execFileAsync('sw_vers', ['-productVersion']),
    execFileAsync('sysctl', ['-n', 'hw.model']),
    execFileAsync('sysctl', ['-n', 'hw.memsize']),
    execFileAsync('sysctl', ['-n', 'machdep.cpu.brand_string']),
  ]);
  return {
    chromePath: resolvedChrome,
    versions: {
      libraries: {
        playwright: await packageVersion('playwright'),
        puppeteer: await packageVersion('puppeteer'),
      },
      node: process.version,
      chrome: chromeStdout.trim(),
      os: `macOS ${macVersion.trim()} (${os.release()})`,
      hardware: `${cpu.trim()}, ${Math.round(Number(memory.trim()) / 1024 ** 3)} GiB, ${model.trim()}`,
    },
  };
}

function parseInteger(args, name, fallback, minimum = 0) {
  const argument = args.find((arg) => arg.startsWith(`--${name}=`));
  if (!argument) return fallback;
  const value = Number(argument.slice(name.length + 3));
  if (!Number.isInteger(value) || value < minimum) throw new Error(`--${name} must be an integer >= ${minimum}`);
  return value;
}

function parseOptions(args) {
  const full = args.includes('--full');
  const pilot = args.includes('--pilot');
  if (full === pilot) throw new Error('Choose exactly one mode: --pilot or --full');
  const allowed = new Set([full ? '--full' : '--pilot']);
  if (pilot) {
    for (const name of ['iterations', 'batches', 'warmups']) {
      if (args.some((arg) => arg.startsWith(`--${name}=`))) allowed.add(`--${name}`);
    }
  }
  for (const arg of args) {
    const name = arg.split('=')[0];
    if (!allowed.has(name)) throw new Error(`Unsupported option ${arg}`);
  }
  return {
    mode: full ? 'full' : 'pilot',
    warmups: full ? FULL.warmups : parseInteger(args, 'warmups', 1),
    iterations: full ? FULL.iterations : parseInteger(args, 'iterations', 5, 1),
    batches: full ? FULL.batches : parseInteger(args, 'batches', 1, 1),
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const { chromePath, versions } = await detectEnvironment();
  const outputPath = path.join(PROJECT_ROOT, 'results', options.mode === 'full' ? 'raw.jsonl' : 'pilot.jsonl');
  const temporaryPath = `${outputPath}.partial`;
  const statusPath = path.join(PROJECT_ROOT, 'results', `${options.mode}-status.json`);
  await mkdir(path.dirname(outputPath), { recursive: true });
  try {
    await access(temporaryPath);
    throw new Error(`${temporaryPath} already exists. Inspect and explicitly remove incomplete data before rerunning.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (options.mode === 'full') {
    try {
      await access(outputPath);
      throw new Error(`${outputPath} already exists. A full run cannot overwrite existing data.`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  const benchmarkId = `${options.mode}-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const fixture = await createFixtureServer();
  const stream = createWriteStream(temporaryPath, { flags: 'wx' });
  let executionOrder = 0;
  let failures = 0;
  let measuredRecords = 0;
  let warmupRecords = 0;
  const expectedMeasuredRecords = SCENARIOS.length * LIBRARIES.length * options.iterations * options.batches;
  const expectedWarmupRecords = SCENARIOS.length * LIBRARIES.length * options.warmups;
  const expectedRecords = expectedMeasuredRecords + expectedWarmupRecords;

  async function updateStatus(state, current = null) {
    const status = {
      state,
      mode: options.mode,
      benchmarkId,
      expectedRecords,
      completedRecords: executionOrder,
      expectedMeasuredRecords,
      measuredRecords,
      warmupRecords,
      failures,
      current,
      updatedAt: new Date().toISOString(),
    };
    const temporaryStatus = `${statusPath}.tmp`;
    await writeFile(temporaryStatus, `${JSON.stringify(status, null, 2)}\n`);
    await rename(temporaryStatus, statusPath);
  }

  async function execute(library, scenario, batch, iteration, measured) {
    executionOrder += 1;
    const runId = `${benchmarkId}-${executionOrder.toString().padStart(5, '0')}`;
    const current = { library, scenario: scenario.name, batch, iteration, measured, executionOrder };
    const { record } = await runIteration({
      baseUrl: fixture.baseUrl,
      runId,
      benchmarkId,
      library,
      scenario,
      batch,
      iteration,
      measured,
      executionOrder,
      chromePath,
      versions,
    });
    if (!stream.write(`${JSON.stringify(record)}\n`)) await once(stream, 'drain');
    if (!record.success) failures += 1;
    if (measured) measuredRecords += 1;
    else warmupRecords += 1;
    if (executionOrder % 10 === 0 || executionOrder === expectedRecords) {
      await updateStatus('running', current);
      console.log(`${options.mode} ${executionOrder}/${expectedRecords}: measured=${measuredRecords}, warmups=${warmupRecords}, failures=${failures}`);
    }
  }

  try {
    console.log(JSON.stringify({ benchmarkId, options, chromePath, versions, scenarios: SCENARIOS.map((scenario) => scenario.name) }, null, 2));
    await updateStatus('running');
    for (let iteration = 1; iteration <= options.warmups; iteration += 1) {
      for (let scenarioIndex = 0; scenarioIndex < SCENARIOS.length; scenarioIndex += 1) {
        const libraries = (iteration + scenarioIndex) % 2 === 0 ? LIBRARIES : [...LIBRARIES].reverse();
        for (const library of libraries) await execute(library, SCENARIOS[scenarioIndex], 0, iteration, false);
      }
    }
    for (let batch = 1; batch <= options.batches; batch += 1) {
      const scenarios = batch % 2 === 0 ? [...SCENARIOS].reverse() : [...SCENARIOS];
      for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex += 1) {
        const scenario = scenarios[scenarioIndex];
        for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
          const libraries = (iteration + scenarioIndex + batch) % 2 === 0 ? LIBRARIES : [...LIBRARIES].reverse();
          for (const library of libraries) await execute(library, scenario, batch, iteration, true);
        }
      }
    }
    stream.end();
    await once(stream, 'finish');
    await rename(temporaryPath, outputPath);
    await updateStatus('complete');
    console.log(`Complete: ${outputPath}; measured=${measuredRecords}, warmups=${warmupRecords}, failures=${failures}`);
  } catch (error) {
    stream.destroy();
    await updateStatus('incomplete', { message: errorText(error) });
    throw error;
  } finally {
    await fixture.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}
