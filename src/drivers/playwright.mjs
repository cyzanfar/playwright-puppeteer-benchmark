import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CHROME_ARGS, configurePageSession, crashRenderer } from '../browser-config.mjs';

export function createPlaywrightDriver(chromePath) {
  const sessions = new WeakMap();
  const profiles = new WeakMap();

  return {
    name: 'playwright',
    async launch() {
      const profile = await mkdtemp(path.join(os.tmpdir(), 'nina-playwright-'));
      try {
        const browser = await chromium.launch({
          executablePath: chromePath,
          headless: true,
          timeout: 10_000,
          ignoreDefaultArgs: true,
          args: [...CHROME_ARGS, `--user-data-dir=${profile}`],
        });
        profiles.set(browser, profile);
        return browser;
      } catch (error) {
        await rm(profile, { recursive: true, force: true });
        throw error;
      }
    },
    async newContext(browser) {
      return browser.newContext();
    },
    async newPage(context) {
      const page = await context.newPage();
      const session = await context.newCDPSession(page);
      sessions.set(page, session);
      await configurePageSession(session);
      return page;
    },
    async goto(page, url) {
      const response = await page.goto(url, { waitUntil: 'load', timeout: 10_000 });
      if (!response) throw new Error(`No response for ${url}`);
      return response.status();
    },
    async waitForRecords(page) {
      await page.waitForSelector('#records tr[data-id="6"]', { state: 'attached', timeout: 10_000 });
    },
    async evaluate(page, callback) {
      return page.evaluate(callback);
    },
    async crashPage(page) {
      const session = sessions.get(page);
      if (!session) throw new Error('Missing Playwright CDP session');
      await crashRenderer(session);
    },
    async closePage(page) {
      if (!page.isClosed()) await page.close({ runBeforeUnload: false });
    },
    async closeContext(context) {
      await context.close();
    },
    async closeBrowser(browser) {
      try {
        await browser.close();
      } finally {
        const profile = profiles.get(browser);
        if (profile) await rm(profile, { recursive: true, force: true });
      }
    },
  };
}
