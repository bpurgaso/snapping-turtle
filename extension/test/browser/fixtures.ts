import { test as base, type Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { harnessPath } from './build-harness.js';

export const fixtureUrl = (name: string): string =>
  pathToFileURL(resolve(import.meta.dirname, 'fixtures', `${name}.html`)).href;

/** Navigate to a fixture page and inject the harness bundle. */
export async function openFixture(page: Page, name: string): Promise<void> {
  await page.goto(fixtureUrl(name));
  await page.addScriptTag({ path: harnessPath });
  await page.evaluate(() => {
    window.__stTest = {};
  });
}

export const test = base;
export const expect = test.expect;
