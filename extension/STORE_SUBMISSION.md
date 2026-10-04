# Store submission kit (M8, PLAN.md §2 "Extension distribution", §15)

Everything the human with the store accounts needs to publish the extension:
Chrome Web Store as an **unlisted** item, Firefox through **AMO signing +
self-distribution** from the server's `/ext/` route. Nothing here can be
automated from the repo — both stores require a personal developer account —
so this is a checklist with the copy drafted, the permission justifications
written, and the data-use disclosure filled in truthfully.

Status of every step below: **unverified** — nobody has submitted yet. Tick
them off as you go and record the dates/versions at the bottom. Since E8 the
two inputs the console demands beyond the zip — a privacy-policy URL and
screenshots — come from the repository: the policy is served live at
`/privacy` from its canonical file, and the screenshots are generated into
`store-assets/` by a script.

## 0. Build the artifacts

```sh
# deploy/.env must carry the real PUBLIC_HOST and a pinned EXTENSION_GECKO_ID
pnpm --filter extension build:release
```

Produces `extension/dist/snapping-turtle-chrome-<version>.zip` and
`…-firefox-<version>.zip`, both stamped with `extension/package.json`'s
version, both defaulting to `https://$PUBLIC_HOST:$PUBLIC_PORT` (the port is part of the origin), both audited: manifests
generated from `manifest.template.json` only, no `http://` or loopback
origins outside the options page's help text, no debug logging, no source
maps or stray files, zip identical to `dist/<target>/`, and addons-linter
clean in self-hosted mode. The build refuses to run with the placeholder
origin or without `EXTENSION_GECKO_ID`.

Bump `extension/package.json` `version` for every submission (stores and AMO
reject a re-used version), commit, and tag `v<version>` — the release
workflow (`.github/workflows/release.yml`) attaches both zips to the GitHub
release. Signing stays local.

## 1. Chrome Web Store — unlisted listing

### Account (one-time)

1. Sign in to <https://chrome.google.com/webstore/devconsole> with the Google
   account that will own the item. Pay the one-time developer registration
   fee and accept the developer agreement.
2. Optionally set up a publisher display name; it appears on the listing.

### Upload

3. **New item** → upload `snapping-turtle-chrome-<version>.zip`.
4. **Store listing** tab — copy below. Category: _Productivity_ (or
   _Developer Tools_). Language: English.
5. **Privacy practices** tab — single purpose, permission justifications and
   data disclosures below. A **privacy policy URL** is mandatory because the
   extension handles user data: enter
   `https://$PUBLIC_HOST:$PUBLIC_PORT/privacy` — the server serves the policy
   there (§"Privacy policy" below). Before you paste it, load it once from
   outside your network and read it as the reviewer will.
6. **Distribution** tab — Visibility: **Unlisted**. Payments: free. Regions:
   all (or your choice). Unlisted items are reachable only by direct link and
   never appear in search, which is the intent for a friends-only server.
7. **Submit for review.** Review typically takes hours to a few days; the
   `activeTab` + `scripting` combination without `<all_urls>` keeps it in the
   low-friction tier. If the reviewer asks for a test account, create a
   throwaway user on your server via the admin panel's one-time link and
   share it with a token (revoke both afterwards).
8. When published, copy the item URL
   (`https://chromewebstore.google.com/detail/<id>`) into `deploy/.env` as
   `CHROME_EXTENSION_URL` and `docker compose up -d`: the home page's Chrome
   card turns from "coming soon" into **Install for Chrome**. Unlisted items
   never appear in store search, so that direct link is the only way in —
   the home page is where users find it.

### Listing copy (draft — edit freely, keep it truthful)

- **Name:** snapping-turtle
- **Summary (≤132 chars):** Capture the visible tab, a region or the whole
  page and share it at a private link on your own snapping-turtle server.
- **Description:**

  > snapping-turtle captures screenshots and uploads them to a
  > snapping-turtle server that you (or a friend) run — not to us, not to any
  > cloud service. Each capture gets a private, unguessable link where you can
  > annotate with rectangles, arrows and text, and anyone with the link sees
  > the annotated image plus a link back to the original page.
  >
  > Three capture modes: the visible viewport, a selected region, or the full
  > page (Alt+Shift+S / R / F, configurable). Uploads are authenticated with a
  > personal API token you create on your server's account page.
  >
  > You need access to a snapping-turtle server to use this extension; the
  > server software is open source at <repository URL>.

- **Icon:** `extension/icons/icon-128.png`.
- **Screenshots (at least one, 1280×800 or 640×400; JPEG or 24-bit PNG, no
  alpha; up to five):** upload the generated set in
  [`store-assets/`](store-assets/) — `01-capture-page.png` (a capture as a
  viewer sees it), `02-editor.png` (the owner's editor mid-annotation, toolbar
  showing) and `03-popup.png` (the toolbar popup on a neutral backdrop), each
  exactly 1280×800. They are a build artifact, not a one-off:
  `pnpm --filter extension listing-shots` boots a throwaway server, uploads
  the bundled fixture page (`store-assets/fixture/demo-page.html`, invented
  content, `example.com` addresses), annotates it through the API and
  re-captures all three, so every listing update ships matching screenshots
  (`store-assets/README.md`). Never replace them with a screenshot of a real
  capture or a real page.
- **Promotional images (optional, not produced here):** the console also
  accepts a small promo tile (440×280) and a marquee (1400×560), JPEG or
  24-bit PNG. The listing publishes without them.

### Single purpose

> Capture a screenshot of the current tab and upload it to the user's own
> snapping-turtle server, opening the resulting private page.

### Permission justifications

| Permission                                        | Justification (paste as-is)                                                                                                                                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `activeTab`                                       | Grants capture and script-injection rights on the one tab the user invoked the extension on, only for that gesture. This is how the extension takes the screenshot (`captureVisibleTab`) without requesting access to all sites.                       |
| `scripting`                                       | Injects the region-selection overlay and the full-page scroll driver into the invoked tab, on demand, after the user clicks Region or Full page. No content script is declared in the manifest; nothing runs on pages the user did not ask to capture. |
| `storage`                                         | Stores the user's server address, their API token, the last-used capture mode and the region-suggestions preference in `storage.local` on this device only. `storage.sync` is deliberately not used so the token never leaves the browser profile.     |
| `notifications`                                   | Reports an upload failure once the popup has closed or when the capture was started from a keyboard shortcut — the only channel left at that point.                                                                                                    |
| Host permission for the build-time default server | The single origin uploads are sent to: the snapping-turtle server this build was made for.                                                                                                                                                             |
| `optional_host_permissions: https://*/*`          | Lets a user who runs their own server at a different domain grant access to exactly that origin from the options page. Requested at runtime for one origin at a time, never for all sites.                                                             |
| Remote code                                       | **No.** All code ships in the package; the extension loads no remote scripts and evaluates no remote content.                                                                                                                                          |

### Data use disclosure (Privacy practices → "What user data do you plan to collect?")

Tick, truthfully:

- **Website content** — the screenshot pixels of the page the user chose to
  capture.
- **Web history** — the URL and title of that one page, sent with the
  capture so the share page can link back to it.
- **Authentication information** — the personal API token the user pastes
  into the options page, stored locally and sent as a bearer token to the
  user's server.

Leave unticked: personally identifiable information, health, financial,
personal communications, location, user activity (no clicks, keystrokes or
browsing are recorded — only the one page the user captures). Region mode's
element suggestions (0.2.0) change none of this: they read the layout of the
tab the user invoked the extension on, locally, to draw a highlight, and
what leaves the browser is still only the captured image, its URL and title.

Certifications (all three are true and must be ticked):

- I do not sell or transfer user data to third parties, outside of the
  approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my
  item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for
  lending purposes.

### Privacy policy (the URL you enter)

The policy is **one file**, `web/content/privacy.md` in this repository. The
web build copies it into the bundle and the server renders it at
`https://$PUBLIC_HOST:$PUBLIC_PORT/privacy` — an ordinary public page
(indexable, cacheable, same CSP), linked from the home page's footer. That
URL is what goes into the console; this document deliberately does not repeat
the text, and `server/test/unit/privacy-page.test.ts` fails if the URL here,
the route and the file drift apart.

The text is the owner's: it is what you certify to Google, so wording changes
are made in that one file, by you or with your sign-off, never silently — and
a change ships with the app (`docker compose … up -d --build`), not with the
extension. The policy describes the whole product (both extensions and the
Linux desktop client), so one URL serves every listing.

The URL embeds the deployment's host and port: a domain migration must update
it in the console (`docs/runbooks/domain-migration.md` step 4).

## 2. Firefox — AMO signing and self-distribution

Firefox refuses to install unsigned extensions, so every build is signed by
Mozilla's AMO service; distribution then happens from **your** server
(PLAN.md §2 decision), which also delivers updates. No AMO listing, no store
copy, no review queue for a listing — only the automated signing checks.

### Account and credentials (one-time)

1. Create a Firefox Account and sign in at
   <https://addons.mozilla.org/developers/>. Accept the developer agreement.
2. Generate API credentials at
   <https://addons.mozilla.org/developers/addon/api/key/>: a **JWT issuer**
   (`user:…`) and a **JWT secret**. The secret is shown once.
3. Keep them in a password manager. They go into the environment of the
   shell that signs — **never** into `deploy/.env`, the repository, CI
   secrets, or a shell history file (CLAUDE.md rule 12):

   ```sh
   read -rs WEB_EXT_API_KEY && export WEB_EXT_API_KEY      # paste the issuer
   read -rs WEB_EXT_API_SECRET && export WEB_EXT_API_SECRET  # paste the secret
   ```

4. Pin the add-on id **once** in `deploy/.env`:
   `EXTENSION_GECKO_ID=snapping-turtle@<your-domain>` (any `name@host` or a
   `{GUID}`). AMO creates the add-on on first signing under this id and
   accepts later versions only under the same id — it must survive domain
   migrations unchanged (`docs/runbooks/domain-migration.md`).

### Sign and publish a version

```sh
pnpm --filter extension build:release
pnpm --filter extension sign:firefox
```

`sign:firefox` uploads `dist/firefox/` on the **unlisted** channel, waits for
AMO's automated validation and signature (usually one to a few minutes),
downloads the signed `.xpi` into `dist/signed/`, copies it to
`deploy/ext/snapping-turtle-firefox-<version>.xpi` and upserts
`deploy/ext/updates.json` (sha256 of the file, `strict_min_version`). The
app serves both at `https://$PUBLIC_HOST:$PUBLIC_PORT/ext/` immediately (compose mounts
`deploy/ext` read-only; no restart needed). Verify:

```sh
curl -sS https://$PUBLIC_HOST:$PUBLIC_PORT/ext/updates.json | grep -E '"version"|update_link'
curl -sSI https://$PUBLIC_HOST:$PUBLIC_PORT/ext/snapping-turtle-firefox-<version>.xpi | grep -i content-type
#   → application/x-xpinstall
```

If AMO's review queue holds a version (rare on the unlisted channel, but
possible when the validator flags something), the CLI times out waiting;
download the signed file from the developer hub once it is approved and
publish it with `pnpm --filter extension sign:firefox --xpi <path>`.

The manifest declares `data_collection_permissions: { required:
["websiteContent", "browsingActivity"] }` — the honest categories for
"screenshots and the page URL/title, sent to the user's own server" — which
AMO requires for new submissions and Firefox 140+ shows in the install
prompt. `strict_min_version` is 140.0 (Firefox for Android 142.0) for that
reason.

### Install and updates for users

- First install: open `https://$PUBLIC_HOST:$PUBLIC_PORT/ext/snapping-turtle-firefox-<version>.xpi`
  in Firefox → allow the site to install add-ons → confirm the permissions.
  Put that link on your `/account` page or in the message that hands over
  the one-time account link.
- Updates: Firefox checks `update_url` (`https://$PUBLIC_HOST:$PUBLIC_PORT/ext/updates.json`)
  about once a day and installs newer versions on its own. Publishing a
  version is therefore `build:release` + `sign:firefox`, nothing else.

## 3. Record of submissions

| Date | Version | Chrome item id / status | AMO version status | Notes |
| ---- | ------- | ----------------------- | ------------------ | ----- |
| —    | —       | not yet submitted       | not yet signed     | —     |

Listing inputs on record — fill in when first entered, update when they change
(a domain migration changes the first; every regenerated screenshot set the
second):

| Input              | Value                                                                                                                                            | Entered / last updated |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| Privacy policy URL | `https://$PUBLIC_HOST:$PUBLIC_PORT/privacy` (write the real host; not yet set)                                                                   | —                      |
| Screenshot set     | `extension/store-assets/` at commit `…` (the `listing-shots` run that made it)                                                                   | —                      |
| Screenshot set     | regenerated after E9 (the editor toolbar gained **Redact**; `listing-shots` run on top of `c53738b`) — upload this set with the first submission | 2026-10-03             |
