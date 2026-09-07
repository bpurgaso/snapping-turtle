/* global browser, self, createImageBitmap */
// Throwaway probe (never shipped): what does this Firefox expose on browser.tabs
// under each permission set, before and after a toolbar gesture?
const REPORT = self.__REPORT_URL__ || 'http://127.0.0.1:47391/report';
async function report(obj) {
  try {
    await fetch(REPORT, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify(obj),
    });
  } catch (e) {
    console.error('report failed', e);
  }
}
function snapshot() {
  return {
    captureTab: typeof browser.tabs.captureTab,
    captureVisibleTab: typeof browser.tabs.captureVisibleTab,
    hasOwnCaptureTab: Object.prototype.hasOwnProperty.call(browser.tabs, 'captureTab'),
    keys: Object.keys(browser.tabs).filter((k) => /capture/i.test(k)),
  };
}
async function size(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const d = `${bmp.width}x${bmp.height}`;
  bmp.close();
  return d;
}
async function tryCall(fn) {
  try {
    return { ok: await size(await fn()) };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}
const mv = browser.runtime.getManifest().manifest_version;
const name = browser.runtime.getManifest().name;
report({ name, mv, phase: 'startup', ...snapshot(), permissions: null }).then(async () => {
  const perms = await browser.permissions.getAll();
  await report({ name, mv, phase: 'startup-perms', ...perms });
});
const action = browser.action || browser.browserAction;
action.onClicked.addListener(async (tab) => {
  const out = { name, mv, phase: 'gesture', before: snapshot() };
  if (
    browser.runtime.getManifest().optional_host_permissions ||
    (browser.runtime.getManifest().optional_permissions || []).length
  ) {
    const want = self.__REQUEST_ORIGIN__ || '<all_urls>';
    try {
      out.requested = { want, granted: await browser.permissions.request({ origins: [want] }) };
    } catch (e) {
      out.requested = { want, error: String((e && e.message) || e) };
    }
    out.afterRequest = snapshot();
  }
  out.visible = await tryCall(() =>
    browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' }),
  );
  out.native =
    typeof browser.tabs.captureTab === 'function'
      ? await tryCall(() =>
          browser.tabs.captureTab(tab.id, {
            format: 'png',
            rect: { x: 0, y: 0, width: 800, height: 3000 },
            scale: 1,
          }),
        )
      : { skipped: 'captureTab is ' + typeof browser.tabs.captureTab };
  out.perms = await browser.permissions.getAll();
  await report(out);
});
