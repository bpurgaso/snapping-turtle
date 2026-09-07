// Throwaway harness: headless system Firefox via geckodriver; temporary-install one probe
// extension; collect what its background reports at startup and after a real browser-action
// trigger (Firefox's own triggerAction, which grants activeTab exactly like a toolbar click).
import { spawn } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Usage: node run.mjs <probe dir>   (geckodriver from `npm i --no-save geckodriver` in
// the parent directory; Firefox at FIREFOX_BIN or /usr/bin/firefox). The five probe
// directories differ only in their manifest; background.js is copied in from here.
const here = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(process.argv[2]);
copyFileSync(resolve(here, 'background.js'), resolve(extDir, 'background.js'));
const gdPort = 4444 + Number(process.pid % 1000);
const REPORT_PORT = 47391;
const reports = [];
const page = `<!doctype html><title>st-probe</title><body style="margin:0"><div style="height:5000px;background:linear-gradient(red,blue)">tall</div>`;
const server = createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      reports.push(JSON.parse(body));
      res.end('ok');
    });
    return;
  }
  res.setHeader('content-type', 'text/html');
  res.end(page);
});
await new Promise((r) => server.listen(REPORT_PORT, '127.0.0.1', r));
const gd = spawn(
  resolve(here, '..', 'node_modules', '.bin', 'geckodriver'),
  ['--port', String(gdPort), '--allow-system-access'],
  { stdio: 'ignore' },
);
const base = `http://127.0.0.1:${gdPort}`;
const api = async (method, path, body) => {
  const payload = path.endsWith('/execute/sync') ? { args: [], ...body } : (body ?? {});
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(payload) : undefined,
  });
  const json = await res.json();
  if (json.value && json.value.error)
    throw new Error(`${path}: ${json.value.error}: ${json.value.message}`);
  return json.value;
};
const until = async (pred, ms = 15000) => {
  for (let i = 0; i < ms / 250; i++) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};
await new Promise((r) => setTimeout(r, 1500));
let sessionId;
try {
  const session = await api('POST', '/session', {
    capabilities: {
      alwaysMatch: {
        browserName: 'firefox',
        'moz:firefoxOptions': {
          binary: process.env.FIREFOX_BIN || '/usr/bin/firefox',
          args: ['-headless'],
          prefs: {
            'extensions.webextOptionalPermissionPrompts': false,
            'extensions.webextensions.remote': true,
            'layout.css.devPixelsPerPx': '1',
          },
        },
      },
    },
  });
  sessionId = session.sessionId;
  const s = `/session/${sessionId}`;
  await api('POST', `${s}/window/rect`, { width: 1000, height: 800 });
  const addonId = await api('POST', `${s}/moz/addon/install`, { path: extDir, temporary: true });
  await api('POST', `${s}/url`, { url: `http://127.0.0.1:${REPORT_PORT}/st-probe` });
  await until(() => reports.some((r) => r.phase === 'startup-perms'));
  await api('POST', `${s}/moz/context`, { context: 'chrome' });
  const triggered = await api('POST', `${s}/execute/sync`, {
    script: `
    const [id] = arguments;
    const policy = WebExtensionPolicy.getByID(id);
    const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
    const action = ExtensionParent.apiManager.global.browserActionFor(policy.extension);
    action.triggerAction(window);
    return { manifestVersion: policy.extension.manifestVersion, hasAllUrls: policy.extension.hasPermission("<all_urls>") };
  `,
    args: [addonId],
  });
  const got = await until(() => reports.some((r) => r.phase === 'gesture'), 20000);
  console.log(
    JSON.stringify(
      {
        ext: extDir.split('/').pop(),
        firefox: session.capabilities.browserVersion,
        triggered,
        gestureReported: got,
        reports,
      },
      null,
      1,
    ),
  );
} finally {
  if (sessionId) await api('DELETE', `/session/${sessionId}`).catch(() => {});
  gd.kill();
  server.close();
}
