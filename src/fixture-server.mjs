import http from 'node:http';

export const RECORDS = Object.freeze([
  { id: 1, name: 'Atlas', category: 'sensors', value: 42, inStock: true },
  { id: 2, name: 'Boreal', category: 'controllers', value: 37, inStock: false },
  { id: 3, name: 'Cinder', category: 'sensors', value: 91, inStock: true },
  { id: 4, name: 'Delta', category: 'gateways', value: 18, inStock: true },
  { id: 5, name: 'Ember', category: 'controllers', value: 63, inStock: false },
  { id: 6, name: 'Flux', category: 'gateways', value: 75, inStock: true },
]);

export const FAKE_CREDENTIALS = Object.freeze({
  username: 'benchmark-user',
  password: 'not-a-real-password',
});

const JS_RENDER_DELAY_MS = 40;
const SLOW_RESPONSE_DELAY_MS = 90;

function emptyRun(resetCount = 0) {
  return {
    resetCount,
    failures: new Map(),
    sessions: new Map(),
    loginCount: 0,
    expirationCount: 0,
    protectedAllowed: 0,
    protectedDenied: 0,
    requests: [],
  };
}

function rows() {
  return RECORDS.map((record) => `<tr data-id="${record.id}"><td class="id">${record.id}</td><td class="name">${record.name}</td><td class="category">${record.category}</td><td class="value">${record.value}</td><td class="in-stock">${record.inStock}</td></tr>`).join('');
}

function document(body, script = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Nina benchmark fixture</title></head><body><main>${body}</main>${script}</body></html>`;
}

function recordsDocument() {
  return document(`<h1>Records</h1><table><thead><tr><th>ID</th><th>Name</th><th>Category</th><th>Value</th><th>In stock</th></tr></thead><tbody id="records">${rows()}</tbody></table>`);
}

function send(response, status, body, headers = {}) {
  const payload = Buffer.from(body);
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(payload);
}

function sendJson(response, status, value) {
  const payload = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
  });
  response.end(payload);
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const separator = part.indexOf('=');
    return separator < 0 ? [part, ''] : [part.slice(0, separator), part.slice(separator + 1)];
  }));
}

function validRunId(runId) {
  return typeof runId === 'string' && /^[A-Za-z0-9._-]{1,180}$/.test(runId);
}

export async function createFixtureServer() {
  const runs = new Map();

  function stateFor(runId) {
    if (!runs.has(runId)) runs.set(runId, emptyRun());
    return runs.get(runId);
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const runId = url.searchParams.get('runId');

    if (!validRunId(runId)) {
      sendJson(response, 400, { error: 'A valid unique runId query parameter is required' });
      return;
    }

    const state = stateFor(runId);
    state.requests.push({ path: url.pathname, method: request.method });

    if (url.pathname === '/__reset') {
      const resetCount = state.resetCount + 1;
      runs.set(runId, emptyRun(resetCount));
      sendJson(response, 200, { reset: runId, resetCount });
      return;
    }

    if (url.pathname === '/basic') {
      send(response, 200, recordsDocument());
      return;
    }

    if (url.pathname === '/js') {
      const script = `<script>const records=${JSON.stringify(RECORDS)};setTimeout(()=>{document.getElementById('records').innerHTML=records.map(r=>'<tr data-id="'+r.id+'"><td class="id">'+r.id+'</td><td class="name">'+r.name+'</td><td class="category">'+r.category+'</td><td class="value">'+r.value+'</td><td class="in-stock">'+r.inStock+'</td></tr>').join('');},${JS_RENDER_DELAY_MS});</script>`;
      send(response, 200, document('<h1>Records</h1><table><tbody id="records"></tbody></table>', script));
      return;
    }

    if (url.pathname === '/slow') {
      setTimeout(() => send(response, 200, recordsDocument()), SLOW_RESPONSE_DELAY_MS);
      return;
    }

    if (url.pathname === '/failure') {
      const key = url.searchParams.get('key') || 'primary';
      const attempt = (state.failures.get(key) || 0) + 1;
      state.failures.set(key, attempt);
      if (attempt <= 2) {
        send(response, 503, document(`<p id="failure">Controlled failure ${attempt}</p>`), { 'Retry-After': '0' });
      } else {
        send(response, 200, recordsDocument());
      }
      return;
    }

    if (url.pathname === '/session/login') {
      if (url.searchParams.get('username') !== FAKE_CREDENTIALS.username || url.searchParams.get('password') !== FAKE_CREDENTIALS.password) {
        send(response, 403, document('<p id="error">Invalid fake credentials</p>'));
        return;
      }
      state.loginCount += 1;
      const token = `${runId}-session-${state.loginCount}`;
      state.sessions.set(token, { expiresAt: Date.now() + 3_600_000 });
      const protectedUrl = `/session/protected?runId=${encodeURIComponent(runId)}`;
      send(response, 303, '', {
        Location: protectedUrl,
        'Set-Cookie': `nina_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600`,
      });
      return;
    }

    if (url.pathname === '/session/expire') {
      if (state.sessions.size === 0) {
        send(response, 409, document('<p id="error">No session to expire</p>'));
        return;
      }
      for (const session of state.sessions.values()) session.expiresAt = 0;
      state.expirationCount += 1;
      send(response, 200, document('<p id="expired">Session expired</p>'));
      return;
    }

    if (url.pathname === '/session/protected') {
      const token = parseCookies(request.headers.cookie).nina_session;
      const session = state.sessions.get(token);
      if (!session || session.expiresAt <= Date.now()) {
        state.protectedDenied += 1;
        send(response, 401, document('<p id="error">Session expired</p>'));
        return;
      }
      state.protectedAllowed += 1;
      send(response, 200, recordsDocument());
      return;
    }

    send(response, 404, document('<p id="error">Not found</p>'));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    inspect(runId) {
      const state = runs.get(runId);
      if (!state) return null;
      return {
        resetCount: state.resetCount,
        failures: Object.fromEntries(state.failures),
        sessionCount: state.sessions.size,
        loginCount: state.loginCount,
        expirationCount: state.expirationCount,
        protectedAllowed: state.protectedAllowed,
        protectedDenied: state.protectedDenied,
        requests: state.requests.map((entry) => ({ ...entry })),
      };
    },
    async close() {
      if (!server.listening) return;
      server.closeAllConnections();
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}
