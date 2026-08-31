import './capture.css';
import './editor.css';
import { ANNOTATION_STYLE, type AnnotationDocument } from '@snapping-turtle/shared/annotations';
import { annotations, currentSession } from './api.js';
import { wireCopyButtons } from './copy.js';
import { CaptureEditor } from './editor/capture-editor.js';

/**
 * Entry for the owner's capture page (§9). The server renders #editor-root
 * only for the authenticated owner; everything here degrades to the static
 * image if the session has meanwhile expired — the server still enforces
 * ownership on every save (CLAUDE.md rule 8).
 */
wireCopyButtons();

const root = document.getElementById('editor-root');
if (root) void init(root);

async function init(root: HTMLElement): Promise<void> {
  const d = root.dataset;
  const viewId = d['viewId'];
  const width = Number(d['width']);
  const height = Number(d['height']);
  const imageUrl = d['imageUrl'];
  if (!viewId || !imageUrl || !Number.isFinite(width) || !Number.isFinite(height)) return;

  const session = await currentSession();
  if (!session) return; // signed out since the page rendered: keep the static image

  let doc: AnnotationDocument;
  try {
    doc = await annotations.get(viewId);
  } catch {
    return; // e.g. capture deleted in another tab; the static page stands
  }

  // Fabric measures text in the annotation font; load it before mounting so
  // glyph metrics match the server renderer's from the first frame (§10).
  try {
    await document.fonts.load(`${ANNOTATION_STYLE.defaultFontSize}px Inter`);
  } catch {
    /* font API unavailable: system fallback still renders */
  }

  const editor = new CaptureEditor(root, {
    viewId,
    width,
    height,
    imageUrl,
    csrfToken: session.csrfToken,
    doc,
    createdAt: d['createdAt'] ?? '',
    retentionUntil: d['retentionUntil'] ?? '',
    retentionMaxDays: Number(d['retentionMaxDays']) || 365,
  });
  await editor.mount();
}
