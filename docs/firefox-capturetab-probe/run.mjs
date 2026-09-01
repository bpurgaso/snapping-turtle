// Minimal WebDriver client: start Firefox via geckodriver, install the probe temporarily,
// open the tall page, wait for the extension to write RESULT:{...} into the title.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dpr = process.argv[2] ?? '1';
const headless = process.argv[3] !== 'headed';
const port = 4444 + Number(process.pid % 1000);
const gd = spawn(resolve('node_modules/.bin/geckodriver'), ['--port', String(port)], {
  stdio: 'ignore',
});
const base = `http://127.0.0.1:${port}`;
const api = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (json.value && json.value.error)
    throw new Error(`${path}: ${json.value.error}: ${json.value.message}`);
  return json.value;
};
const html = readFileSync(resolve('probe-page.html'));
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/st-probe`;
await new Promise((r) => setTimeout(r, 1500));
let sessionId;
try {
  const session = await api('POST', '/session', {
    capabilities: {
      alwaysMatch: {
        browserName: 'firefox',
        'moz:firefoxOptions': {
          binary: '/Applications/Firefox.app/Contents/MacOS/firefox',
          args: headless ? ['-headless'] : [],
          prefs: { 'layout.css.devPixelsPerPx': dpr, 'extensions.webextensions.remote': true },
        },
      },
    },
  });
  sessionId = session.sessionId;
  const s = `/session/${sessionId}`;
  await api('POST', `${s}/window/rect`, { width: 1000, height: 800 });
  await api('POST', `${s}/moz/addon/install`, { path: resolve('ext'), temporary: true });
  await api('POST', `${s}/url`, { url: pageUrl });
  let title = '';
  for (let i = 0; i < 120 && !title.startsWith('RESULT:'); i++) {
    await new Promise((r) => setTimeout(r, 500));
    title = await api('GET', `${s}/title`);
  }
  if (!title.startsWith('RESULT:')) throw new Error('probe never reported; title=' + title);
  const results = JSON.parse(title.slice('RESULT:'.length));
  console.log(JSON.stringify({ requestedDpr: dpr, headless, ...results }, null, 2));
} finally {
  if (sessionId) await api('DELETE', `/session/${sessionId}`).catch(() => {});
  gd.kill();
  server.close();
}
