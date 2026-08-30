import browser from 'webextension-polyfill';

// M0: the background exists so both targets have a real entry to load.
// Capture, upload and command handling arrive in M2/M6 (PLAN.md §15).
browser.runtime.onInstalled.addListener((details) => {
  console.info(`snapping-turtle installed (${details.reason})`);
});
