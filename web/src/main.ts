import { ANNOTATION_SCHEMA_VERSION, MAX_IMAGE_HEIGHT_PX } from '@snapping-turtle/shared/constants';
import { el, mount } from './dom.js';

// Landing page: a short description and the way in. Importing from shared
// proves the workspace wiring reaches the browser bundle.
const root = document.getElementById('app');
if (root) {
  mount(
    root,
    el('h1', { text: 'snapping-turtle' }),
    el('p', { text: 'Self-hosted screenshot capture and sharing.' }),
    el('nav', { className: 'nav' }, [
      el('a', { text: 'Sign in', attrs: { href: '/login' } }),
      el('a', { text: 'Account', attrs: { href: '/account' } }),
    ]),
    el('p', {
      className: 'meta',
      text: `annotation schema v${ANNOTATION_SCHEMA_VERSION} · height cap ${MAX_IMAGE_HEIGHT_PX.toLocaleString()} px`,
    }),
  );
}
