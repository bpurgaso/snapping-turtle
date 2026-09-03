import type { ParityFixture } from '@snapping-turtle/shared/parity-fixtures';
import { StaticCanvas } from 'fabric';
import { annotationSizes, objectFromShape } from '../../../src/editor/shapes.js';

/**
 * Browser half of the render-parity harness (§10): renders a fixture with the
 * REAL editor code — `objectFromShape` from web/src/editor/shapes.ts on a
 * Fabric canvas — and hands back a PNG data URL for pixel comparison against
 * the server composite. Bundled as an IIFE by test/parity/global-setup.ts and
 * injected into about:blank; never part of the shipped bundle.
 */

let interLoaded: Promise<void> | null = null;

/**
 * Register the vendored Inter once per page. Deliberately not guarded by
 * `document.fonts.check('16px Inter')`: that returns true when *no* face named
 * Inter is registered at all (nothing would block rendering), so the M4
 * harness skipped the load and measured every fixture in Chromium's fallback
 * font — text ran ~11% narrower than the server's Inter and the whole-image
 * tolerance hid it (found and fixed in E1, PLAN.md §10).
 */
function ensureFont(fontDataUrl: string): Promise<void> {
  interLoaded ??= (async () => {
    const face = new FontFace('Inter', `url(${fontDataUrl})`);
    await face.load();
    document.fonts.add(face);
    await document.fonts.load('16px Inter');
  })();
  return interLoaded;
}

async function render(fixture: ParityFixture, fontDataUrl: string): Promise<string> {
  await ensureFont(fontDataUrl);
  const el = document.createElement('canvas');
  document.body.append(el);
  const canvas = new StaticCanvas(el, {
    width: fixture.width,
    height: fixture.height,
    backgroundColor: fixture.background,
    enableRetinaScaling: false,
    renderOnAddRemove: false,
  });
  try {
    // The same per-width sizes the editor computes for a capture (§9 E1).
    const sizes = annotationSizes(fixture.width);
    for (const shape of fixture.shapes) canvas.add(objectFromShape(shape, sizes));
    canvas.renderAll();
    return canvas.toDataURL({ format: 'png', multiplier: 1, enableRetinaScaling: false });
  } finally {
    await canvas.dispose();
    el.remove();
  }
}

declare global {
  interface Window {
    __parity: { render: typeof render };
  }
}

window.__parity = { render };
