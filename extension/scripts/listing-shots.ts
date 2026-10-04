import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  ANNOTATION_SCHEMA_VERSION,
  CAPTURE_UPLOAD_FIELDS,
} from '@snapping-turtle/shared/constants';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

/**
 * Store-listing screenshots as a build artifact (E8, PLAN.md §15):
 *
 *   DATABASE_URL=postgres://… pnpm --filter extension listing-shots
 *
 * Boots the real server (server/test/helpers/demo-server.ts) against a
 * throwaway database with PUBLIC_ORIGIN = https://shots.example.com:28443 so
 * every URL in the pictures is a placeholder domain; renders the bundled
 * fixture page (store-assets/fixture/demo-page.html — invented content) at
 * 1280×800 and uploads it as the demo capture; saves a rectangle, an arrow and
 * a text label through the annotation API; then photographs
 *
 *   01-capture-page.png  the capture page as a viewer sees it (flat render)
 *   02-editor.png        the owner's editor with the toolbar and a selected shape
 *   03-popup.png         the built Chrome extension's popup, staged on a backdrop
 *
 * each exactly 1280×800, 24-bit PNG without alpha (what the Chrome Web Store
 * accepts), into store-assets/. The browser never talks to the placeholder
 * host: a Playwright route proxies https://shots.example.com:28443/* to the
 * local server, so the pages render with production-shaped links while the
 * only network is loopback. Needs web/dist and dist/chrome built (the package
 * script builds both) and Playwright's Chromium (`playwright install chromium`).
 */

const repo = fileURLToPath(new URL('../..', import.meta.url));
const assetsDir = join(repo, 'extension/store-assets');
const fixture = join(assetsDir, 'fixture/demo-page.html');
const distChrome = join(repo, 'extension/dist/chrome');
const webDist = join(repo, 'web/dist');

const SHOT = { width: 1280, height: 800 };
/** What the screenshots show as the server; routed to the loopback server below. */
const DEMO_ORIGIN = 'https://shots.example.com:28443';
const DEMO_HOST = new URL(DEMO_ORIGIN).hostname;
const port = Number(process.env['LISTING_SHOTS_PORT'] ?? 3123);
const local = `http://127.0.0.1:${port}`;
/** Obviously fake; only ever lands in the throwaway profile's storage.local. */
const FAKE_TOKEN = 'st_FAKEFAKEFAKEFAKEFAKEFAKEFAK';

interface DemoServer {
  origin: string;
  token: string;
  username: string;
  password: string;
}

/** Thrown, never process.exit: the `finally` below must stop the server and clean up. */
class ListingShotsError extends Error {}
function fail(message: string): never {
  throw new ListingShotsError(message);
}

// ---- preconditions ----------------------------------------------------------

if (!process.env['DATABASE_URL']) fail('DATABASE_URL (a throwaway Postgres) is required');
if (!existsSync(join(webDist, '.vite/manifest.json'))) fail('web/dist is not built');
if (!existsSync(join(distChrome, 'manifest.json'))) fail('dist/chrome is not built');
if (!existsSync(fixture)) fail(`fixture missing: ${fixture}`);

// ---- the throwaway server ---------------------------------------------------

const imagesDir = mkdtempSync(join(tmpdir(), 'st-listing-images-'));
let server: ChildProcess | undefined;

function startServer(): Promise<DemoServer> {
  server = spawn(
    'pnpm',
    ['--filter', '@snapping-turtle/server', 'exec', 'tsx', 'test/helpers/demo-server.ts'],
    {
      cwd: repo,
      // Own process group so the whole pnpm → tsx → node chain dies with it.
      detached: true,
      stdio: ['ignore', 'pipe', 'inherit'],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: String(port),
        PUBLIC_ORIGIN: DEMO_ORIGIN,
        LOG_LEVEL: 'warn',
        SESSION_SECRET: 'listing-shots-session-secret-not-real-0123456789',
        IMAGES_DIR: imagesDir,
        WEB_DIST_DIR: webDist,
        RATE_GENERAL_PER_MIN: '100000',
      },
    },
  );
  return new Promise((resolve, reject) => {
    let buffer = '';
    server!.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const line = buffer.indexOf('\n');
      if (line !== -1) resolve(JSON.parse(buffer.slice(0, line)) as DemoServer);
    });
    server!.on('exit', (code) => reject(new Error(`demo server exited early (${code})`)));
  });
}

function stopServer(): void {
  if (!server?.pid) return;
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    server.kill('SIGTERM');
  }
}

// ---- API helpers (Node side, loopback) --------------------------------------

async function upload(demo: DemoServer, png: Buffer): Promise<string> {
  const form = new FormData();
  form.append(
    CAPTURE_UPLOAD_FIELDS.image,
    new Blob([new Uint8Array(png)], { type: 'image/png' }),
    'demo-page.png',
  );
  form.append(CAPTURE_UPLOAD_FIELDS.sourceUrl, 'https://docs.example.com/guides/getting-started');
  form.append(CAPTURE_UPLOAD_FIELDS.title, 'Getting started · Example Docs');
  const res = await fetch(`${local}/api/v1/captures`, {
    method: 'POST',
    headers: { authorization: `Bearer ${demo.token}` },
    body: form,
  });
  if (res.status !== 201) fail(`upload failed: ${res.status} ${await res.text()}`);
  const { pageUrl } = (await res.json()) as { pageUrl: string };
  if (!pageUrl.startsWith(`${DEMO_ORIGIN}/s/`)) fail(`unexpected pageUrl ${pageUrl}`);
  return pageUrl.slice(pageUrl.lastIndexOf('/') + 1);
}

interface Session {
  cookieHeader: string;
  cookies: Array<{ name: string; value: string }>;
  csrfToken: string;
}

async function signIn(demo: DemoServer): Promise<Session> {
  const res = await fetch(`${local}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: demo.username, password: demo.password }),
  });
  if (res.status !== 200) fail(`login failed: ${res.status}`);
  const cookies = res.headers.getSetCookie().map((c) => {
    const [pair] = c.split(';');
    const eq = pair!.indexOf('=');
    return { name: pair!.slice(0, eq), value: pair!.slice(eq + 1) };
  });
  const { csrfToken } = (await res.json()) as { csrfToken: string };
  return {
    cookies,
    cookieHeader: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
    csrfToken,
  };
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The red/white look: one rectangle, one arrow, one label — placed from the fixture's measured boxes. */
function demoShapes(callout: Rect, button: Rect) {
  const r = (n: number) => Math.round(n);
  const head = { x: r(button.x + button.width / 2), y: r(button.y + button.height + 6) };
  // Tail and label sit in the empty right-hand column below the fixture's "On this page" list.
  const tail = { x: head.x + 150, y: head.y + 125 };
  return [
    {
      id: 'callout',
      type: 'rect',
      x: r(callout.x - 10),
      y: r(callout.y - 10),
      w: r(callout.width + 20),
      h: r(callout.height + 20),
    },
    { id: 'arrow', type: 'arrow', x1: tail.x, y1: tail.y, x2: head.x, y2: head.y },
    { id: 'label', type: 'text', x: tail.x - 40, y: tail.y + 8, text: 'Start here', fontSize: 28 },
  ];
}

async function saveAnnotations(viewId: string, session: Session, shapes: unknown[]): Promise<void> {
  const res = await fetch(`${local}/api/v1/captures/${viewId}/annotations`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      cookie: session.cookieHeader,
      'x-csrf-token': session.csrfToken,
    },
    body: JSON.stringify({ version: ANNOTATION_SCHEMA_VERSION, rev: 0, shapes }),
  });
  if (res.status !== 200) fail(`annotation save failed: ${res.status} ${await res.text()}`);
}

// ---- the placeholder origin, proxied to loopback -----------------------------

/**
 * Chromium never resolves shots.example.com: every request to it is answered
 * from the local server, with the owner's cookie added for the owner context
 * (Playwright does not expose the cookie header to route handlers).
 */
async function proxyDemoOrigin(context: BrowserContext, cookieHeader?: string): Promise<void> {
  await proxyOrigin(context, DEMO_ORIGIN, cookieHeader);
}

async function proxyOrigin(
  context: BrowserContext,
  origin: string,
  cookieHeader?: string,
): Promise<void> {
  await context.route(`${origin}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const headers: Record<string, string> = { ...req.headers() };
    delete headers['host'];
    if (cookieHeader) headers['cookie'] = cookieHeader;
    const body = req.postDataBuffer();
    const res = await fetch(`${local}${url.pathname}${url.search}`, {
      method: req.method(),
      headers,
      ...(body ? { body: new Uint8Array(body) } : {}),
      redirect: 'manual',
    });
    const out: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      if (
        !['content-encoding', 'content-length', 'transfer-encoding', 'set-cookie'].includes(key)
      ) {
        out[key] = value;
      }
    });
    await route.fulfill({
      status: res.status,
      headers: out,
      body: Buffer.from(await res.arrayBuffer()),
    });
  });
}

// ---- shots -------------------------------------------------------------------

async function renderFixture(
  browser: Browser,
): Promise<{ png: Buffer; callout: Rect; button: Rect }> {
  const page = await browser.newPage({
    viewport: SHOT,
    deviceScaleFactor: 1,
    colorScheme: 'light',
  });
  await page.goto(`file://${fixture}`);
  await page.evaluate(() => document.fonts.ready);
  const box = async (selector: string): Promise<Rect> => {
    const b = await page.locator(selector).boundingBox();
    if (!b) fail(`fixture element ${selector} has no box`);
    return b;
  };
  const callout = await box('#callout');
  const button = await box('#primary-button');
  const png = await page.screenshot({ type: 'png' });
  await page.close();
  return { png, callout, button };
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
}

async function viewerShot(browser: Browser, viewId: string): Promise<Buffer> {
  const context = await browser.newContext({
    viewport: SHOT,
    deviceScaleFactor: 1,
    colorScheme: 'light',
  });
  await proxyDemoOrigin(context);
  const page = await context.newPage();
  await page.goto(`${DEMO_ORIGIN}/s/${viewId}`);
  await page.locator('img.shot').evaluate((img) => (img as HTMLImageElement).decode());
  await settle(page);
  const png = await page.screenshot({ type: 'png' });
  await context.close();
  return png;
}

async function editorShot(
  browser: Browser,
  viewId: string,
  session: Session,
  imageWidth: number,
  callout: Rect,
): Promise<Buffer> {
  const context = await browser.newContext({
    viewport: SHOT,
    deviceScaleFactor: 1,
    colorScheme: 'light',
  });
  await context.addCookies(
    session.cookies.map((c) => ({
      ...c,
      domain: DEMO_HOST,
      path: '/',
      secure: true,
      httpOnly: c.name === 'st_session',
    })),
  );
  await proxyDemoOrigin(context, session.cookieHeader);
  const page = await context.newPage();
  await page.goto(`${DEMO_ORIGIN}/s/${viewId}`);
  const canvas = page.locator('#editor-root canvas.upper-canvas');
  await canvas.waitFor();
  await page.locator('.save-state', { hasText: 'Saved' }).waitFor();
  await settle(page);
  // Mid-annotation: select the rectangle so its handles show next to the toolbar.
  const box = (await canvas.boundingBox())!;
  const scale = box.width / imageWidth;
  await page.mouse.click(box.x + (callout.x + 24) * scale, box.y + (callout.y + 12) * scale);
  await page.waitForTimeout(150);
  const png = await page.screenshot({ type: 'png' });
  await context.close();
  return png;
}

/** The popup, photographed from the built extension at 2× then staged on a plain backdrop. */
async function popupShot(browser: Browser): Promise<Buffer> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'st-listing-ext-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${distChrome}`, `--load-extension=${distChrome}`],
    viewport: { width: 300, height: 400 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
  });
  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).hostname;

    // Configured state, as a user would have it: server set, token present, Region used last.
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options/index.html`);
    await options.evaluate((items) => chrome.storage.local.set(items), {
      serverOrigin: DEMO_ORIGIN,
      apiToken: FAKE_TOKEN,
      lastMode: 'region',
    });
    await options.close();

    // The popup decides what it can do from the active tab of its window, and
    // without the toolbar gesture (activeTab) it can read a tab's URL only on an
    // origin the manifest grants — the build's default server. So that origin
    // is routed to loopback like the demo origin, an ordinary page is opened
    // there and made active, and the popup is created as a *background* tab of
    // that window through the extension's own tabs API (`create` needs no
    // permission). Opened as the active tab the popup would see itself
    // (restricted, every mode disabled); this way it sees the page.
    const defaultOrigin = builtDefaultOrigin();
    await proxyOrigin(context, defaultOrigin);
    const site = await context.newPage();
    await site.goto(`${defaultOrigin}/`);
    const popupUrl = `chrome-extension://${extensionId}/popup/index.html`;
    const opener = await context.newPage();
    await opener.goto(`chrome-extension://${extensionId}/options/index.html`);
    await site.bringToFront();
    await opener.evaluate(
      async ({ sitePattern, url }) => {
        // `create` is not in the smoke tests' chrome stub (test/smoke/chrome.d.ts).
        const tabs = chrome.tabs as unknown as {
          query(info: { url: string }): Promise<Array<{ windowId: number }>>;
          create(props: { url: string; active: boolean; windowId: number }): Promise<unknown>;
        };
        const [tab] = await tabs.query({ url: sitePattern });
        if (!tab) throw new Error('site tab not visible to the extension');
        await tabs.create({ url, windowId: tab.windowId, active: false });
      },
      { sitePattern: `${defaultOrigin}/*`, url: popupUrl },
    );
    const popup = await pageAt(context, popupUrl);
    await popup.locator('.modes button:enabled').first().waitFor();
    await popup.bringToFront();
    await popup.setViewportSize({ width: 300, height: 400 });
    const main = (await popup.locator('main').boundingBox())!;
    const height = Math.ceil(main.y + main.height + 4);
    const raw = await popup.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 300, height } });
    return stagePopup(browser, raw, 300, height);
  } finally {
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

/** The default server baked into dist/chrome, from its generated manifest's host permission. */
function builtDefaultOrigin(): string {
  const manifest = JSON.parse(readFileSync(join(distChrome, 'manifest.json'), 'utf8')) as {
    host_permissions: string[];
  };
  const [pattern] = manifest.host_permissions;
  if (!pattern?.endsWith('/*')) fail(`unexpected host_permissions in dist/chrome: ${pattern}`);
  return pattern.slice(0, -2);
}

/** The page the extension opened at `url`, once Playwright has attached to it. */
async function pageAt(context: BrowserContext, url: string): Promise<Page> {
  for (let i = 0; i < 150; i++) {
    const page = context.pages().find((p) => p.url().startsWith(url));
    if (page) {
      await page.waitForLoadState('domcontentloaded');
      return page;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return fail(`no page opened at ${url}`);
}

/** A neutral backdrop with a hint of browser chrome; the popup hangs under the toolbar as it does in life. */
async function stagePopup(
  browser: Browser,
  popupPng: Buffer,
  cssWidth: number,
  cssHeight: number,
): Promise<Buffer> {
  const page = await browser.newPage({
    viewport: SHOT,
    deviceScaleFactor: 1,
    colorScheme: 'light',
  });
  const dataUrl = `data:image/png;base64,${popupPng.toString('base64')}`;
  await page.setContent(`<!doctype html>
    <html><head><meta charset="utf-8"><style>
      html, body { margin: 0; width: 1280px; height: 800px; overflow: hidden; }
      body { background: linear-gradient(160deg, #eceff3 0%, #dde3ea 100%); font-family: system-ui, sans-serif; }
      .toolbar { height: 52px; background: #f8f9fa; border-bottom: 1px solid #d0d5db; display: flex; align-items: center; gap: 14px; padding: 0 16px; }
      .dot { width: 12px; height: 12px; border-radius: 50%; background: #c9ced6; }
      .omnibox { flex: 1; height: 32px; margin: 0 24px; border-radius: 16px; background: #e9ecf0; }
      .icon { width: 28px; height: 28px; border-radius: 8px; background: #b42318; box-shadow: 0 0 0 3px #fbe3e0; }
      .icon + .icon { background: #c9ced6; box-shadow: none; }
      .popup { position: absolute; top: 58px; right: 56px; width: ${cssWidth}px; height: ${cssHeight}px;
               border-radius: 10px; box-shadow: 0 18px 48px rgba(15, 23, 42, 0.22), 0 0 0 1px rgba(15, 23, 42, 0.08);
               background: #fff; overflow: hidden; }
      .popup img { display: block; width: ${cssWidth}px; height: ${cssHeight}px; }
    </style></head>
    <body>
      <div class="toolbar"><span class="dot"></span><span class="dot"></span><span class="dot"></span>
        <span class="omnibox"></span><span class="icon"></span><span class="icon"></span></div>
      <div class="popup"><img alt="" src="${dataUrl}"></div>
    </body></html>`);
  await page.locator('.popup img').evaluate((img) => (img as HTMLImageElement).decode());
  const png = await page.screenshot({ type: 'png' });
  await page.close();
  return png;
}

// ---- output ------------------------------------------------------------------

/** Exactly 1280×800, 24-bit RGB without alpha (the Web Store's PNG requirement). */
function writeShot(name: string, raw: Buffer): void {
  const png = PNG.sync.read(raw);
  if (png.width !== SHOT.width || png.height !== SHOT.height) {
    fail(`${name}: ${png.width}×${png.height}, expected ${SHOT.width}×${SHOT.height}`);
  }
  writeFileSync(join(assetsDir, name), PNG.sync.write(png, { colorType: 2 }));
  console.log(`listing-shots: wrote store-assets/${name} (${SHOT.width}×${SHOT.height})`);
}

// ---- main ----------------------------------------------------------------------

try {
  const demo = await startServer();
  if (demo.origin !== DEMO_ORIGIN) fail(`server origin ${demo.origin} != ${DEMO_ORIGIN}`);
  const browser = await chromium.launch();
  try {
    const { png, callout, button } = await renderFixture(browser);
    const viewId = await upload(demo, png);
    const session = await signIn(demo);
    await saveAnnotations(viewId, session, demoShapes(callout, button));

    writeShot('01-capture-page.png', await viewerShot(browser, viewId));
    writeShot('02-editor.png', await editorShot(browser, viewId, session, SHOT.width, callout));
    writeShot('03-popup.png', await popupShot(browser));
  } finally {
    await browser.close();
  }
  const kit = readFileSync(join(assetsDir, 'README.md'), 'utf8');
  for (const name of ['01-capture-page.png', '02-editor.png', '03-popup.png']) {
    if (!kit.includes(name)) fail(`store-assets/README.md does not mention ${name}`);
  }
  console.log('listing-shots: done — three 1280×800 PNGs in extension/store-assets/');
} catch (err) {
  console.error(`listing-shots: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  stopServer();
  rmSync(imagesDir, { recursive: true, force: true });
}
