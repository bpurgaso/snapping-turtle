/* global browser, createImageBitmap */
// MV2 so <all_urls> is granted at (temporary) install and no gesture is needed.
async function dims(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const d = { w: bmp.width, h: bmp.height, bytes: blob.size };
  bmp.close();
  return d;
}
async function probe(tabId) {
  const [env] = await browser.tabs.executeScript(tabId, {
    code: 'JSON.stringify({dpr: devicePixelRatio, cw: document.documentElement.clientWidth, ch: document.documentElement.clientHeight, iw: innerWidth, ih: innerHeight, sh: document.documentElement.scrollHeight})',
  });
  const e = JSON.parse(env);
  const W = e.cw;
  const results = { env: e };
  const cases = {
    visibleDefault: {},
    visiblePng: { format: 'png' },
    rectNoScale: { format: 'png', rect: { x: 0, y: 0, width: W, height: 5000 } },
    rectScaleDpr: { format: 'png', rect: { x: 0, y: 0, width: W, height: 5000 }, scale: e.dpr },
    rectScale1: { format: 'png', rect: { x: 0, y: 0, width: W, height: 5000 }, scale: 1 },
    rectScale2: { format: 'png', rect: { x: 0, y: 0, width: W, height: 5000 }, scale: 2 },
    rectReset: {
      format: 'png',
      rect: { x: 0, y: 0, width: W, height: 5000 },
      scale: 1,
      resetScrollPosition: true,
    },
    rectBeyondDoc: { format: 'png', rect: { x: 0, y: 0, width: W, height: 9000 }, scale: 1 },
    rect32000: { format: 'png', rect: { x: 0, y: 0, width: W, height: 32000 }, scale: 1 },
    rect16000x2: { format: 'png', rect: { x: 0, y: 0, width: W, height: 16000 }, scale: 2 },
    rect40000: { format: 'png', rect: { x: 0, y: 0, width: W, height: 40000 }, scale: 1 },
  };
  for (const [name, opts] of Object.entries(cases)) {
    const t0 = performance.now();
    try {
      const url = await browser.tabs.captureTab(tabId, opts);
      results[name] = { ...(await dims(url)), ms: Math.round(performance.now() - t0) };
    } catch (err) {
      results[name] = {
        error: String((err && err.message) || err),
        ms: Math.round(performance.now() - t0),
      };
    }
  }
  await browser.tabs.executeScript(tabId, {
    code: `document.title = ${JSON.stringify('RESULT:' + JSON.stringify(results))}`,
  });
}
browser.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' && tab.url && tab.url.includes('st-probe')) {
    probe(tabId).catch(async (e) => {
      try {
        await browser.tabs.executeScript(tabId, {
          code: `document.title = ${JSON.stringify('RESULT:' + JSON.stringify({ fatal: String((e && e.message) || e) }))}`,
        });
      } catch (e2) {
        console.error('cannot report', e, e2);
      }
    });
  }
});
