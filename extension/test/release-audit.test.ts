import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { auditReleaseFiles, checkReleaseInputs } from '../scripts/lib/release-audit.js';
import { buildManifest, type ManifestTemplate, type Target } from '../src/manifest.js';

const template = JSON.parse(
  readFileSync(new URL('../manifest.template.json', import.meta.url), 'utf8'),
) as ManifestTemplate;
const inputs = {
  version: '0.1.0',
  publicOrigin: 'https://shots.example-deploy.net',
  geckoId: 'snapping-turtle@shots.example-deploy.net',
};
const enc = new TextEncoder();

/** A minimal clean bundle: manifest from the template, one script baking the origin. */
function cleanFiles(target: Target): Map<string, Uint8Array> {
  const manifest = buildManifest(target, { template, ...inputs });
  return new Map<string, Uint8Array>([
    ['manifest.json', enc.encode(JSON.stringify(manifest, null, 2) + '\n')],
    ['background.js', enc.encode(`const o="${inputs.publicOrigin}";fetch(o);`)],
    ['options.js', enc.encode('const hint="https only, except localhost / 127.0.0.1";')],
    ['popup/index.html', enc.encode('<!doctype html><script src="../popup.js"></script>')],
    ['icons/icon-16.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
  ]);
}

describe('checkReleaseInputs', () => {
  it('accepts an https, non-placeholder origin with a pinned gecko id', () => {
    expect(checkReleaseInputs(inputs)).toEqual([]);
    expect(
      checkReleaseInputs({ ...inputs, geckoId: '{12345678-1234-1234-1234-123456789abc}' }),
    ).toEqual([]);
  });

  it('accepts a ported production origin and still refuses loopback/placeholder ones with a port', () => {
    const ported = { ...inputs, publicOrigin: 'https://shots.example-deploy.net:28443' };
    expect(checkReleaseInputs(ported)).toEqual([]);
    expect(checkReleaseInputs({ ...inputs, publicOrigin: 'https://localhost:28443' })).toEqual([
      expect.stringMatching(/loopback/),
    ]);
    expect(checkReleaseInputs({ ...inputs, publicOrigin: 'https://127.0.0.1:28443' })).toEqual([
      expect.stringMatching(/loopback/),
    ]);
    expect(
      checkReleaseInputs({ ...inputs, publicOrigin: 'https://shots.example.com:28443' }),
    ).toEqual([expect.stringMatching(/placeholder/)]);
    expect(checkReleaseInputs({ ...inputs, publicOrigin: 'http://shots.real.net:28443' })).toEqual([
      expect.stringMatching(/must be https/),
    ]);
  });

  it('refuses http, loopback, the placeholder host and a missing or malformed gecko id', () => {
    expect(checkReleaseInputs({ ...inputs, publicOrigin: 'http://shots.real.net' })).toEqual([
      expect.stringMatching(/must be https/),
    ]);
    expect(checkReleaseInputs({ ...inputs, publicOrigin: 'https://localhost' })).toEqual([
      expect.stringMatching(/loopback/),
    ]);
    expect(checkReleaseInputs({ ...inputs, publicOrigin: 'https://shots.example.com' })).toEqual([
      expect.stringMatching(/placeholder/),
    ]);
    const { geckoId: _g, ...noId } = inputs;
    expect(checkReleaseInputs(noId)).toEqual([
      expect.stringMatching(/EXTENSION_GECKO_ID is not set/),
    ]);
    expect(checkReleaseInputs({ ...inputs, geckoId: 'not an id' })).toEqual([
      expect.stringMatching(/neither/),
    ]);
  });
});

describe('auditReleaseFiles', () => {
  for (const target of ['chrome', 'firefox'] as const) {
    it(`${target}: a template-built bundle with the origin baked is clean`, () => {
      const files = cleanFiles(target);
      expect(auditReleaseFiles({ target, files, zip: files, template, inputs })).toEqual([]);
    });

    it(`${target}: a ported origin (PUBLIC_PORT) bakes and audits clean, manifest included`, () => {
      const ported = { ...inputs, publicOrigin: 'https://shots.example-deploy.net:28443' };
      const manifest = buildManifest(target, { template, ...ported });
      const files = new Map(cleanFiles(target));
      files.set('manifest.json', enc.encode(JSON.stringify(manifest, null, 2) + '\n'));
      files.set('background.js', enc.encode(`const o="${ported.publicOrigin}";fetch(o);`));
      expect(auditReleaseFiles({ target, files, zip: files, template, inputs: ported })).toEqual([]);
      expect(manifest.host_permissions).toEqual([
        target === 'chrome'
          ? 'https://shots.example-deploy.net:28443/*'
          : 'https://shots.example-deploy.net/*',
      ]);
      // The same bundle audited against port-less inputs is a mismatch, not a pass.
      expect(auditReleaseFiles({ target, files, template, inputs })).toEqual(
        expect.arrayContaining([expect.stringMatching(/manifest.json differs/)]),
      );
    });
  }

  it('flags a manifest that was not generated from the template with these inputs', () => {
    const files = cleanFiles('chrome');
    const edited = JSON.parse(new TextDecoder().decode(files.get('manifest.json')!)) as {
      permissions: string[];
    };
    edited.permissions.push('tabs');
    files.set('manifest.json', enc.encode(JSON.stringify(edited)));
    expect(auditReleaseFiles({ target: 'chrome', files, template, inputs })).toEqual([
      expect.stringMatching(/manifest.json differs from the template-generated/),
    ]);
    // A stale version stamp is the same failure.
    const stale = new Map(cleanFiles('firefox'));
    stale.set(
      'manifest.json',
      enc.encode(
        JSON.stringify(buildManifest('firefox', { template, ...inputs, version: '0.0.9' })),
      ),
    );
    expect(auditReleaseFiles({ target: 'firefox', files: stale, template, inputs })).toEqual([
      expect.stringMatching(/version 0\.1\.0/),
    ]);
    const missing = cleanFiles('chrome');
    missing.delete('manifest.json');
    expect(auditReleaseFiles({ target: 'chrome', files: missing, template, inputs })).toContain(
      'chrome: manifest.json missing',
    );
  });

  it('flags debug logging, source maps, plain http, loopback hosts and placeholders', () => {
    const cases: Array<[string, RegExp]> = [
      ['console.log("x")', /debug logging/],
      ['console.info("x")', /debug logging/],
      ['console.debug("x")', /debug logging/],
      ['if(a){debugger}', /debug logging/],
      ['//# sourceMappingURL=background.js.map', /source map/],
      ['fetch("http://shots.real.net/api")', /plain http/],
      ['const dev="https://localhost:3000"', /loopback/],
      ['const dev="127.0.0.1"', /loopback/],
      ['const o="https://shots.example.com"', /placeholder/],
      ['const e=process.env.NODE_ENV', /process\.env/],
    ];
    for (const [snippet, expected] of cases) {
      const files = cleanFiles('chrome');
      files.set('background.js', enc.encode(`const o="${inputs.publicOrigin}";${snippet}`));
      const problems = auditReleaseFiles({ target: 'chrome', files, template, inputs });
      expect(problems, snippet).toEqual([expect.stringMatching(expected)]);
    }
  });

  it('allows console.warn/error and the loopback wording in options.js only', () => {
    const files = cleanFiles('firefox');
    files.set(
      'background.js',
      enc.encode(`const o="${inputs.publicOrigin}";console.warn("x");console.error("y")`),
    );
    expect(auditReleaseFiles({ target: 'firefox', files, template, inputs })).toEqual([]);
    files.set('chunks/settings.js', enc.encode('const hint="localhost"'));
    expect(auditReleaseFiles({ target: 'firefox', files, template, inputs })).toEqual([
      expect.stringMatching(/chunks\/settings\.js names a loopback host/),
    ]);
  });

  it('flags files that never ship and a missing baked origin', () => {
    const files = cleanFiles('chrome');
    files.set('background.js.map', enc.encode('{}'));
    files.set('src/background.ts', enc.encode(''));
    files.set('.env', enc.encode('SECRET=1'));
    files.set('test/fixtures/a.js', enc.encode(''));
    const problems = auditReleaseFiles({ target: 'chrome', files, template, inputs });
    expect(problems).toEqual(
      expect.arrayContaining([
        'chrome: background.js.map must not ship in a release',
        'chrome: src/background.ts must not ship in a release',
        'chrome: .env must not ship in a release',
        'chrome: test/fixtures/a.js must not ship in a release',
      ]),
    );
    const unbaked = cleanFiles('chrome');
    unbaked.set('background.js', enc.encode('fetch("/api")'));
    expect(auditReleaseFiles({ target: 'chrome', files: unbaked, template, inputs })).toEqual([
      expect.stringMatching(/no bundle contains the default server/),
    ]);
  });

  it('requires the zip to be exactly the dist directory', () => {
    const files = cleanFiles('chrome');
    const zip = new Map(files);
    zip.delete('icons/icon-16.png');
    expect(auditReleaseFiles({ target: 'chrome', files, zip, template, inputs })).toEqual([
      expect.stringMatching(/zip entries differ/),
    ]);
    const tampered = new Map(files);
    tampered.set('background.js', enc.encode('x'));
    expect(auditReleaseFiles({ target: 'chrome', files, zip: tampered, template, inputs })).toEqual(
      [expect.stringMatching(/zip entry background\.js differs/)],
    );
  });
});
