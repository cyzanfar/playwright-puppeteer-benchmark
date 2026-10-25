import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function listProcesses() {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,rss=,stat=,comm='], { maxBuffer: 8 * 1024 * 1024 });
  const processes = new Map();
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match || match[4].includes('Z')) continue;
    const pid = Number(match[1]);
    processes.set(pid, {
      pid,
      ppid: Number(match[2]),
      rssKiB: Number(match[3]),
      state: match[4],
      command: match[5].trim(),
    });
  }
  return processes;
}

function sameExecutable(actual, expected) {
  return path.resolve(actual) === path.resolve(expected);
}

function chromeBundlePrefix(chromePath) {
  const resolved = path.resolve(chromePath);
  const marker = '.app/';
  const index = resolved.indexOf(marker);
  return index < 0 ? null : `${resolved.slice(0, index + marker.length - 1)}/`;
}

function isChromeBundleProcess(entry, chromePath, bundlePrefix) {
  if (!entry) return false;
  const command = path.resolve(entry.command);
  return sameExecutable(command, chromePath) || (bundlePrefix && command.startsWith(bundlePrefix) && !command.includes('chrome_crashpad_handler'));
}

function selectProcesses(processes, roots, driverPid) {
  const selected = new Map();
  const driver = processes.get(driverPid);
  if (driver) selected.set(driverPid, driver);

  const children = new Map();
  for (const entry of processes.values()) {
    if (!children.has(entry.ppid)) children.set(entry.ppid, []);
    children.get(entry.ppid).push(entry.pid);
  }

  const pending = [...roots];
  const visited = new Set();
  while (pending.length) {
    const pid = pending.pop();
    if (visited.has(pid)) continue;
    visited.add(pid);
    const entry = processes.get(pid);
    if (entry) selected.set(pid, entry);
    for (const child of children.get(pid) || []) pending.push(child);
  }
  return selected;
}

export class ProcessMonitor {
  constructor({ chromePath, driverPid = process.pid, intervalMs = 50 }) {
    this.chromePath = path.resolve(chromePath);
    this.chromeBundlePrefix = chromeBundlePrefix(chromePath);
    this.driverPid = driverPid;
    this.intervalMs = intervalMs;
    this.roots = new Set();
    this.baselinePids = new Set();
    this.baselineChromePids = new Set();
    this.everChromePids = new Set();
    this.timer = null;
    this.sampling = null;
    this.running = false;
    this.sampleCount = 0;
    this.chromeSampleCount = 0;
    this.peakSampledRssKiB = 0;
    this.peakChromeSampledRssKiB = 0;
    this.peakNodeSampledRssKiB = 0;
    this.peakProcessCount = 0;
    this.sampleErrors = [];
    this.leftoverHarnessPids = [];
  }

  async start() {
    const processes = await listProcesses();
    this.baselinePids = new Set(processes.keys());
    this.baselineChromePids = new Set([...processes.values()].filter((entry) => sameExecutable(entry.command, this.chromePath)).map((entry) => entry.pid));
    this.running = true;
    await this.sample();
    this.timer = setInterval(() => {
      this.sample().catch((error) => this.sampleErrors.push(error.message));
    }, this.intervalMs);
  }

  async sample() {
    if (this.sampling) return this.sampling;
    this.sampling = (async () => {
      const processes = await listProcesses();
      const selected = selectProcesses(processes, this.roots, this.driverPid);
      let totalKiB = 0;
      let chromeKiB = 0;
      let nodeKiB = 0;
      let chromeProcesses = 0;
      for (const [pid, entry] of selected) {
        totalKiB += entry.rssKiB;
        if (pid === this.driverPid) {
          nodeKiB = entry.rssKiB;
        } else {
          chromeKiB += entry.rssKiB;
          chromeProcesses += 1;
          this.everChromePids.add(pid);
        }
      }
      this.sampleCount += 1;
      if (chromeProcesses > 0) this.chromeSampleCount += 1;
      this.peakSampledRssKiB = Math.max(this.peakSampledRssKiB, totalKiB);
      this.peakChromeSampledRssKiB = Math.max(this.peakChromeSampledRssKiB, chromeKiB);
      this.peakNodeSampledRssKiB = Math.max(this.peakNodeSampledRssKiB, nodeKiB);
      this.peakProcessCount = Math.max(this.peakProcessCount, selected.size);
    })();
    try {
      await this.sampling;
    } finally {
      this.sampling = null;
    }
  }

  async discoverLaunchedRoots(timeoutMs = 5000) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const processes = await listProcesses();
      const candidates = [...processes.values()].filter((entry) => (
        !this.baselinePids.has(entry.pid)
        && entry.ppid === this.driverPid
        && sameExecutable(entry.command, this.chromePath)
      ));
      for (const entry of candidates) this.roots.add(entry.pid);
      if (this.roots.size > 0) {
        await this.sample();
        return;
      }
      await sleep(25);
    }
    throw new Error('Could not attribute a launched Chrome root process to the Node driver');
  }

  async liveHarnessProcesses() {
    const processes = await listProcesses();
    const live = new Map();
    for (const [pid, entry] of selectProcesses(processes, this.roots, this.driverPid)) {
      if (pid !== this.driverPid && isChromeBundleProcess(entry, this.chromePath, this.chromeBundlePrefix)) live.set(pid, entry);
    }
    for (const pid of this.everChromePids) {
      const entry = processes.get(pid);
      if (!this.baselinePids.has(pid) && isChromeBundleProcess(entry, this.chromePath, this.chromeBundlePrefix)) live.set(pid, entry);
    }
    return [...live.values()];
  }

  async rootsAlive() {
    const processes = await listProcesses();
    return [...this.roots].some((pid) => {
      const entry = processes.get(pid);
      return entry && sameExecutable(entry.command, this.chromePath);
    });
  }

  async waitForOwnedExit(timeoutMs = 5000) {
    const deadline = performance.now() + timeoutMs;
    let live = [];
    while (performance.now() < deadline) {
      live = await this.liveHarnessProcesses();
      if (live.length === 0) {
        this.leftoverHarnessPids = [];
        return true;
      }
      await sleep(50);
    }
    this.leftoverHarnessPids = live.map((entry) => entry.pid);
    return false;
  }

  async terminateOwnedProcesses() {
    const signal = (entries, signalName) => {
      const ordered = [...entries].sort((a, b) => Number(this.roots.has(b.pid)) - Number(this.roots.has(a.pid)));
      for (const entry of ordered) {
        if (this.baselinePids.has(entry.pid) || !isChromeBundleProcess(entry, this.chromePath, this.chromeBundlePrefix)) continue;
        try {
          process.kill(entry.pid, signalName);
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    };

    signal(await this.liveHarnessProcesses(), 'SIGTERM');
    await this.waitForOwnedExit(250);
    const remaining = await this.liveHarnessProcesses();
    if (remaining.length > 0) {
      signal(remaining, 'SIGKILL');
      await this.waitForOwnedExit(2000);
    }
  }

  async stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.sampling) await this.sampling;
    await this.sample();
  }

  report() {
    const unrelated = [...this.baselineChromePids].filter((pid) => this.everChromePids.has(pid));
    return {
      rootPids: [...this.roots].sort((a, b) => a - b),
      rootProcessCount: this.roots.size,
      baselineChromeCount: this.baselineChromePids.size,
      unrelatedChromePidsTracked: unrelated,
      sampleCount: this.sampleCount,
      chromeSampleCount: this.chromeSampleCount,
      peakSampledRssKiB: this.peakSampledRssKiB,
      peakChromeSampledRssKiB: this.peakChromeSampledRssKiB,
      peakNodeSampledRssKiB: this.peakNodeSampledRssKiB,
      peakProcessCount: this.peakProcessCount,
      sampleErrors: this.sampleErrors,
      leftoverHarnessPids: this.leftoverHarnessPids,
      attributionOk: this.roots.size > 0 && this.chromeSampleCount > 0 && unrelated.length === 0 && this.sampleErrors.length === 0,
    };
  }
}
