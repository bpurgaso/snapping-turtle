# Store listing assets (E8)

Generated, not hand-made. The three screenshots the Chrome Web Store listing
uses (`extension/STORE_SUBMISSION.md` §1) come out of one command, so every
listing update ships screenshots that match the build instead of whatever
happened to be on someone's screen:

```sh
DATABASE_URL=postgres://app:ci-only-password@127.0.0.1:5433/app \
  pnpm --filter extension listing-shots
```

The script (`extension/scripts/listing-shots.ts`) builds `web/dist` and
`dist/chrome`, boots the real server against the throwaway database
(`server/test/helpers/demo-server.ts`) with `PUBLIC_ORIGIN` set to the
placeholder `https://shots.example.com:28443`, renders the bundled fixture
page below at 1280×800 and uploads it as the demo capture, saves a rectangle,
an arrow and a text label through the annotation API, and photographs:

| File                  | What it shows                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `01-capture-page.png` | The capture page as anyone with the link sees it: title, source link, copy buttons, the flat render |
| `02-editor.png`       | The owner's editor mid-annotation: the toolbar, the shapes, the rectangle selected with its handles |
| `03-popup.png`        | The built Chrome extension's toolbar popup (Region last used), staged on a neutral backdrop         |

Each is exactly 1280×800, 24-bit PNG without alpha — the store's requirement.
`extension/test/store-assets.test.ts` checks the committed files for exactly
that, so a stray hand-made screenshot of the wrong size fails the unit suite.

## Fixture content

`fixture/demo-page.html` is the page in the pictures: an invented
documentation site with generic text, `example.com` addresses and no real
product, person or organisation. Demo content comes only from here — never
screenshot a real capture or a real page for the listing. The capture link
shown in the pictures is minted on the throwaway server and is dead the
moment the script exits.

## Regenerating

Run the command above after any change to the capture page, the editor or the
popup that a user would see, bump the "Screenshot set" row in
`STORE_SUBMISSION.md` §3, and upload the new set with the next listing
update. The pictures are not byte-stable across runs (the demo capture gets a
fresh id and date each time); what is stable is what they show. Playwright's
Chromium must be installed (`pnpm --filter @snapping-turtle/web exec
playwright install chromium`), and the throwaway Postgres is the same one the
integration suite uses.
