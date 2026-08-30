import { ANNOTATION_SCHEMA_VERSION, MAX_IMAGE_HEIGHT_PX } from '@snapping-turtle/shared/constants';
import { el } from './dom.js';

// M0 placeholder page. Importing from shared proves the workspace wiring
// reaches the browser bundle; the real pages arrive in M1/M3.
const root = document.getElementById('app');
if (root) {
  root.replaceChildren(
    el('h1', { text: 'snapping-turtle' }),
    el('p', { text: 'Self-hosted screenshot capture and sharing.' }),
    el('p', {
      className: 'meta',
      text: `annotation schema v${ANNOTATION_SCHEMA_VERSION} · height cap ${MAX_IMAGE_HEIGHT_PX.toLocaleString()} px`,
    }),
  );
}
