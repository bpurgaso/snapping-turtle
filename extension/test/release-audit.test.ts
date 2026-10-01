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
      expect(auditReleaseFiles({ target, files, zip: files, template, inputs: ported })).toEqual(
        [],
      );
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

  it('flags a template whose permissions cannot back an ungated background call (rule 5)', () => {
    // The 0.1.0 Firefox build called tabs.captureTab with no permission that
    // could enable it. Rule 5 checks the generated manifest against the
    // background's permission contract (src/lib/api-requirements.ts), so a
    // permission dropped from the template fails the release, not the user.
    for (const target of ['chrome', 'firefox'] as const) {
      const stripped = structuredClone(template);
      stripped.permissions = stripped.permissions.filter((p) => p !== 'scripting');
      const manifest = buildManifest(target, { template: stripped, ...inputs });
      const files = cleanFiles(target);
      files.set('manifest.json', enc.encode(JSON.stringify(manifest, null, 2) + '\n'));
      expect(auditReleaseFiles({ target, files, template: stripped, inputs })).toEqual([
        `${target}: scripting.executeScript needs one of scripting in the manifest — the background calls it without a feature check`,
        // …and a dropped permission is also a change to the pinned set (rule 6).
        expect.stringMatching(new RegExp(`^${target}: permission set changed — permissions is `)),
      ]);
    }
    // captureTab is gated (feature-detected, stitch fallback): its missing
    // <all_urls> is not a problem — the clean template audits clean.
    expect(
      auditReleaseFiles({ target: 'firefox', files: cleanFiles('firefox'), template, inputs }),
    ).toEqual([]);
  });

  it('refuses a manifest that declares <all_urls>, in either key (rule 5)', () => {
    for (const target of ['chrome', 'firefox'] as const) {
      const broad = structuredClone(template);
      broad.permissions = [...broad.permissions, '<all_urls>'];
      const manifest = buildManifest(target, { template: broad, ...inputs });
      const files = cleanFiles(target);
      files.set('manifest.json', enc.encode(JSON.stringify(manifest, null, 2) + '\n'));
      expect(auditReleaseFiles({ target, files, template: broad, inputs })).toEqual([
        expect.stringMatching(new RegExp(`^${target}: the manifest declares <all_urls>`)),
        expect.stringMatching(new RegExp(`^${target}: permission set changed — permissions is `)),
      ]);
    }
  });

  it('refuses any change to the pinned permission set, however the template got it (rule 6)', () => {
    // Rule 1 compares the built manifest with the template, so a permission
    // added to the template itself passes it. Rule 6 holds the template to an
    // independent record: E7 added a feature and no permission, and the next
    // feature has to say so in src/lib/api-requirements.ts — and in the store
    // disclosures — before a release builds.
    for (const target of ['chrome', 'firefox'] as const) {
      const audit = (mutate: (t: typeof template) => void): string[] => {
        const changed = structuredClone(template);
        mutate(changed);
        const manifest = buildManifest(target, { template: changed, ...inputs });
        const files = cleanFiles(target);
        files.set('manifest.json', enc.encode(JSON.stringify(manifest, null, 2) + '\n'));
        return auditReleaseFiles({ target, files, template: changed, inputs });
      };
      expect(audit(() => undefined)).toEqual([]);
      expect(audit((t) => t.permissions.push('tabs'))).toEqual([
        `${target}: permission set changed — permissions is ["activeTab","scripting","storage","notifications","tabs"], the pinned set is ["activeTab","scripting","storage","notifications"] (src/lib/api-requirements.ts; a new permission needs the disclosures in STORE_SUBMISSION.md first)`,
      ]);
      expect(audit((t) => t.permissions.reverse())).toEqual([
        expect.stringMatching(/permission set changed — permissions is \["notifications"/),
      ]);
      expect(audit((t) => (t.optional_host_permissions = ['*://*/*']))).toEqual([
        expect.stringMatching(/permission set changed — optional_host_permissions is /),
      ]);
      expect(
        audit((t) =>
          Object.assign(t, { content_scripts: [{ matches: ['https://*/*'], js: ['content.js'] }] }),
        ),
      ).toEqual([
        expect.stringMatching(/permission set changed — content_scripts must not be declared/),
      ]);
    }
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
