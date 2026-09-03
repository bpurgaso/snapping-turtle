import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Renderer-parity guard (§9 E1, §10; in the spirit of scripts/check-image-pins.sh):
 * every drawing size comes from `annotationSizes()` in shared/. A literal
 * stroke, outline, arrowhead or font size reappearing in either renderer
 * would silently break parity or the adaptive curve, so this test greps the
 * renderer sources for the patterns a literal would take and fails on any
 * hit. Screen-space editor chrome (selection handles) is not annotation
 * geometry and lives behind named constants that these patterns do not match.
 */
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Renderer sources: the Fabric editor, its parity harness, and the SVG overlay. */
const RENDERER_PATHS = ['web/src/editor', 'web/src/editor.ts', 'web/test/parity/harness', 'server/src/images'];

const FORBIDDEN: Array<[label: string, re: RegExp]> = [
  ['strokeWidth: <n>', /\bstrokeWidth\s*[:=]\s*\d/],
  ['ctx.lineWidth = <n>', /\blineWidth\s*=\s*\d/],
  ['stroke-width="<n>"', /stroke-width="\d/],
  ['fontSize: <n>', /\bfontSize\s*[:=]\s*\d/],
  ['font-size="<n>"', /font-size="\d/],
  ['font-size: <n>px in an SVG style', /font-size:\s*\d/],
  ['arrowHead*: <n>', /\barrowHead\w*\s*[:=]\s*\d/],
  ['outline / textStrokeWidth / defaultFontSize: <n>', /\b(outline|textStrokeWidth|defaultFontSize)\s*[:=]\s*\d/],
  ['OUTER = <n> (the old module-level derived constant)', /\bOUTER\s*=\s*\d/],
];

function sourceFiles(rel: string): string[] {
  const abs = join(repoRoot, rel);
  if (statSync(abs).isFile()) return [abs];
  return readdirSync(abs, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(abs, f));
}

describe('no literal stroke or font sizes outside shared/ (renderer parity guard)', () => {
  const files = RENDERER_PATHS.flatMap(sourceFiles);

  it('covers both renderers', () => {
    expect(files.some((f) => f.endsWith('web/src/editor/shapes.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('server/src/images/svg-overlay.ts'))).toBe(true);
  });

  for (const file of files) {
    it(`${file.slice(repoRoot.length)} inlines no size literal`, () => {
      const lines = readFileSync(file, 'utf8').split('\n');
      const hits: string[] = [];
      lines.forEach((line, i) => {
        for (const [label, re] of FORBIDDEN) {
          if (re.test(line)) hits.push(`line ${i + 1} (${label}): ${line.trim()}`);
        }
      });
      expect(hits, 'sizes come from annotationSizes() in shared/src/annotations.ts').toEqual([]);
    });
  }

  it('both renderers call the shared size function', () => {
    for (const rel of ['web/src/editor/shapes.ts', 'server/src/images/svg-overlay.ts']) {
      expect(readFileSync(join(repoRoot, rel), 'utf8')).toMatch(/\bannotationSizes\b/);
    }
  });
});
