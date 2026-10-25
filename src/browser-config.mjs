export const USER_AGENT = 'NinaTechnologiesBenchmark/1.0';
export const VIEWPORT = Object.freeze({ width: 1280, height: 900, deviceScaleFactor: 1 });
export const LOCALE = 'en-US';
export const TIMEZONE = 'UTC';

export const CHROME_ARGS = Object.freeze([
  '--headless=new',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--disable-features=Translate,BackForwardCache',
  '--disable-prompt-on-repost',
  '--disable-renderer-backgrounding',
  '--disable-sync',
  '--force-color-profile=srgb',
  '--hide-scrollbars',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-default-browser-check',
  '--no-first-run',
  '--no-service-autorun',
  '--no-startup-window',
  '--password-store=basic',
  '--remote-debugging-pipe',
  '--use-mock-keychain',
  `--user-agent=${USER_AGENT}`,
  `--lang=${LOCALE}`,
  `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
]);

export async function configurePageSession(session) {
  await session.send('Page.enable');
  await session.send('Network.enable');
  await session.send('Network.setCacheDisabled', { cacheDisabled: true });
  await session.send('Network.setUserAgentOverride', {
    userAgent: USER_AGENT,
    acceptLanguage: LOCALE,
  });
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: VIEWPORT.deviceScaleFactor,
    mobile: false,
  });
  await session.send('Emulation.setLocaleOverride', { locale: LOCALE });
  await session.send('Emulation.setTimezoneOverride', { timezoneId: TIMEZONE });
  await session.send('Inspector.enable');
}

export async function crashRenderer(session) {
  let timer;
  let notifyCrash;
  const crashed = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out waiting for Inspector.targetCrashed')), 5000);
    notifyCrash = resolve;
    session.once('Inspector.targetCrashed', notifyCrash);
  });
  const sending = (async () => {
    try {
      await session.send('Page.crash');
    } catch (error) {
      if (!/target (?:crashed|closed)|session closed|connection closed/i.test(error.message)) throw error;
    }
  })();

  try {
    await Promise.race([sending, crashed]);
    await crashed;
  } finally {
    clearTimeout(timer);
    if (typeof session.off === 'function') session.off('Inspector.targetCrashed', notifyCrash);
    else session.removeListener('Inspector.targetCrashed', notifyCrash);
  }
}
