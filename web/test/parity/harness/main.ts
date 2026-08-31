import type { ParityFixture } from '@snapping-turtle/shared/parity-fixtures';
import { StaticCanvas } from 'fabric';
import { objectFromShape } from '../../../src/editor/shapes.js';

/**
 * Browser half of the render-parity harness (§10): renders a fixture with the
 * REAL editor code — `objectFromShape` from web/src/editor/shapes.ts on a
 * Fabric canvas — and hands back a PNG data URL for pixel comparison against
 * the server composite. Bundled as an IIFE by test/parity/global-setup.ts and
 * injected into about:blank; never part of the shipped bundle.
 */

async function ensureFont(fontDataUrl: string): Promise<void> {
  if (document.fonts.check('16px Inter')) return;
  const face = new FontFace('Inter', `url(${fontDataUrl})`);
  await face.load();
  document.fonts.add(face);
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
    for (const shape of fixture.shapes) canvas.add(objectFromShape(shape));
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
