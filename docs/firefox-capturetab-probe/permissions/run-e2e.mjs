// End-to-end (E5): the built Firefox artifact, temporarily installed in the system Firefox
// (headless), full-page-captures a tall page through the real `capture-full` shortcut path
// and uploads to the real server harness. Proves the runtime stitch fallback on Firefox.
//
//   DATABASE_URL=postgres://… node permissions/run-e2e.mjs [path/to/extension/dist/firefox]
//
// Build the artifact first with the harness origin baked in:
//   PUBLIC_ORIGIN=http://127.0.0.1:3119 pnpm --filter @snapping-turtle/extension build:firefox
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const extDir = resolve(process.argv[2] ?? resolve(repo, 'extension/dist/firefox'));
const PORT = Number(process.env.CLIENT_TEST_PORT ?? 3119);
const PAGE_PORT = 47392;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL (a throwaway Postgres) is required');

const work = mkdtempSync(resolve(tmpdir(), 'st-ff-e2e-'));
const env = {
  ...process.env,
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: String(PORT),
  PUBLIC_ORIGIN: `http://127.0.0.1:${PORT}`,
  LOG_LEVEL: 'warn',
  SESSION_SECRET: 'firefox-e2e-secret-not-real-0123456789',
  IMAGES_DIR: `${work}/images`,
  WEB_DIST_DIR: process.env.WEB_DIST_DIR ?? resolve(repo, 'web/dist'),
};
const harness = [
  '--filter',
  '@snapping-turtle/server',
  'exec',
  'tsx',
  'test/helpers/client-harness.ts',
];
const server = spawn('pnpm', [...harness, 'serve'], {
  cwd: repo,
  env,
  stdio: ['ignore', 'pipe', 'inherit'],
});
const firstLine = await new Promise((res, rej) => {
  let buf = '';
  server.stdout.on('data', (c) => {
    buf += c;
    const i = buf.indexOf('\n');
    if (i >= 0) res(buf.slice(0, i));
  });
  server.on('exit', (code) => rej(new Error(`server exited ${code}`)));
});
const { origin, token } = JSON.parse(firstLine);
if (origin !== env.PUBLIC_ORIGIN)
  throw new Error(`harness origin ${origin} != ${env.PUBLIC_ORIGIN}`);
const check = () =>
  JSON.parse(
    execFileSync('pnpm', [...harness, 'check'], { cwd: repo, env, encoding: 'utf8' })
      .trim()
      .split('\n')
      .pop(),
  );

const page = `<!doctype html><title>st e2e tall page</title><body style="margin:0"><div id="h" style="position:fixed;top:0;left:0;right:0;height:40px;background:#0f0">fixed header</div><div style="height:5000px;background:linear-gradient(red,blue)">tall</div>`;
const pages = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(page);
});
await new Promise((r) => pages.listen(PAGE_PORT, '127.0.0.1', r));
// Unique per run so the row check cannot match a capture from an earlier run.
const pageUrl = `http://127.0.0.1:${PAGE_PORT}/tall-${process.pid}-${Date.now()}`;

const gdPort = 4444 + Number(process.pid % 1000);
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
const until = async (fn, ms) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
};
await new Promise((r) => setTimeout(r, 1500));
let sessionId;
let outcome = { ok: false };
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
  await api('POST', `${s}/moz/context`, { context: 'chrome' });
  const uuid = await api('POST', `${s}/execute/sync`, {
    script: 'return WebExtensionPolicy.getByID(arguments[0]).mozExtensionHostname;',
    args: [addonId],
  });
  await api('POST', `${s}/moz/context`, { context: 'content' });

  // 1. The real options form: server address (pre-filled from the build) + token, Save.
  await api('POST', `${s}/url`, { url: `moz-extension://${uuid}/options/index.html` });
  const el = async (css) =>
    (await api('POST', `${s}/element`, { using: 'css selector', value: css }))[
      'element-6066-11e4-a52e-4f735466cecf'
    ];
  const originEl = await el('#origin');
  const originValue = await api('GET', `${s}/element/${originEl}/property/value`);
  await api('POST', `${s}/element/${await el('#token')}/value`, { text: token });
  await api('POST', `${s}/element/${await el('button[type=submit]')}/click`);
  const saved = await until(async () => {
    const t = await api('GET', `${s}/element/${await el('#status')}/text`);
    return /saved/i.test(t) ? t : null;
  }, 10000);

  // 2. The tall page in the same (active) tab, then the shortcut the way Firefox fires it:
  //    dispatch `command` on the extension's XUL <key> for Alt+Shift+F — ExtensionShortcuts'
  //    listener runs ext-commands' onCommand, which grants activeTab and fires the event.
  await api('POST', `${s}/url`, { url: pageUrl });
  await api('POST', `${s}/execute/sync`, {
    script: 'window.scrollTo(0, 777); return document.title;',
  });
  const tabsBefore = (await api('GET', `${s}/window/handles`)).length;
  await api('POST', `${s}/moz/context`, { context: 'chrome' });
  const fired = await api('POST', `${s}/execute/sync`, {
    script: `
    const keys = [...document.querySelectorAll('keyset[id^="ext-keyset-id-"] key')];
    const key = keys.find((k) => k.getAttribute('key') === 'F' && /alt/.test(k.getAttribute('modifiers')) && /shift/.test(k.getAttribute('modifiers')));
    if (!key) return { keys: keys.map((k) => k.outerHTML) };
    key.dispatchEvent(new window.Event('command', { bubbles: true }));
    return { dispatched: key.outerHTML };
  `,
  });
  await api('POST', `${s}/moz/context`, { context: 'content' });

  // 3. A capture row appears and a tab opened on its page.
  const row = await until(() => {
    const r = check();
    return r && r.sourceUrl === pageUrl ? r : null;
  }, 60000);
  const tabsAfter = (await api('GET', `${s}/window/handles`)).length;
  await api('POST', `${s}/moz/context`, { context: 'chrome' });
  // What the toolbar shows afterwards: a "!" badge carries the failure message as its tooltip.
  const badge = await api('POST', `${s}/execute/sync`, {
    script: `
    const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
    const action = ExtensionParent.apiManager.global.browserActionFor(WebExtensionPolicy.getByID(arguments[0]).extension).action;
    return { badgeText: action.getProperty(null, 'badgeText'), title: action.getProperty(null, 'title') };
  `,
    args: [addonId],
  });
  await api('POST', `${s}/moz/context`, { context: 'content' });
  const scrollY = await api('POST', `${s}/execute/sync`, { script: 'return window.scrollY;' });
  const headerVisible = await api('POST', `${s}/execute/sync`, {
    script: "return getComputedStyle(document.getElementById('h')).visibility;",
  });
  outcome = {
    ok: !!row && tabsAfter === tabsBefore + 1,
    firefox: session.capabilities.browserVersion,
    extension: extDir,
    originPrefilled: originValue,
    saved,
    fired,
    row: row && { ...row, viewId: row.viewId.slice(0, 8) + '…' },
    tabsBefore,
    tabsAfter,
    scrollYAfter: scrollY,
    headerVisibleAfter: headerVisible,
    badge,
  };
} finally {
  console.log(JSON.stringify(outcome, null, 1));
  if (sessionId) await api('DELETE', `/session/${sessionId}`).catch(() => {});
  gd.kill();
  pages.close();
  server.kill('SIGTERM');
  rmSync(work, { recursive: true, force: true });
}
process.exit(outcome.ok ? 0 : 1);
