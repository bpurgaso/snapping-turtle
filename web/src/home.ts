import './styles.css';
import { detectBrowser } from './browser-detect.js';
import { el } from './dom.js';

// Home page (E2): the server renders both install cards; this only marks the
// visitor's browser's card with a badge and a class. It never hides or
// rewrites either card, so a wrong guess — or no script at all — costs nothing.
const browser = detectBrowser(navigator.userAgent);
const card = browser
  ? document.querySelector<HTMLElement>(`.browser[data-browser="${browser}"]`)
  : null;
if (card) {
  card.classList.add('yours');
  card.querySelector('h3')?.append(' ', el('span', { className: 'badge', text: 'your browser' }));
}
