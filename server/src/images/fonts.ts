import { fileURLToPath } from 'node:url';

/**
 * Point librsvg's text stack at the repo-pinned font before sharp first
 * rasterizes an SVG (PLAN.md §10). Two knobs, both defaulted here and
 * overridable from the environment:
 *
 *  - FONTCONFIG_PATH → server/fontconfig, whose fonts.conf registers exactly
 *    one font, shared/fonts/Inter-Regular.ttf.
 *  - PANGOCAIRO_BACKEND=fontconfig — sharp's macOS binaries otherwise pick
 *    pango's CoreText backend, which ignores fontconfig entirely and resolves
 *    system fonts (verified against sharp 0.35.4); on Linux fontconfig is the
 *    only backend, so forcing it is a no-op there.
 *
 * Pango reads both variables lazily on first text layout, so calling this any
 * time before the first render is enough. Idempotent; import for side effect.
 */
export const fontconfigDir = fileURLToPath(new URL('../../fontconfig', import.meta.url));

export function pinRendererFonts(env: NodeJS.ProcessEnv = process.env): void {
  env['FONTCONFIG_PATH'] ??= fontconfigDir;
  env['PANGOCAIRO_BACKEND'] ??= 'fontconfig';
}
