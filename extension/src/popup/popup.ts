import { CAPTURE_TILE_INTERVAL_MS } from '@snapping-turtle/shared/constants';

// M0 placeholder popup: the three capture modes from PLAN.md §15, not yet wired.
// Built with DOM APIs only (no innerHTML) — MV3 pages run under a strict CSP.
const MODES = ['Visible', 'Region', 'Full page'] as const;

const root = document.getElementById('popup');
if (root) {
  const heading = document.createElement('h1');
  heading.textContent = 'snapping-turtle';
  root.append(heading);

  for (const mode of MODES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.disabled = true;
    button.textContent = mode;
    root.append(button);
  }

  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = `Capture arrives in M2 (tile pacing ${CAPTURE_TILE_INTERVAL_MS} ms).`;
  root.append(note);
}
