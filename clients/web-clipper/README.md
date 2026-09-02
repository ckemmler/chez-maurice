# Save to Maurice — browser clipper

A Chrome (MV3) extension that saves the page you are reading into your Maurice
garden as an article fiche, with a note.

It exists for one reason the iOS share sheet and the server cannot solve on
their own: **it sends the DOM your browser already rendered.** A server-side
fetch of a Le Monde or NYT article meets a paywall or a Cloudflare check and
saves *that* page instead — the garden still holds two such captures, filed
under the titles "Client Challenge" and "Security Verification". The page in
your tab is already past all of it.

## Install

Not on the Web Store — load it unpacked:

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → pick this directory (`clients/web-clipper/`).
3. Pin the bookmark icon to the toolbar.

Works in any Chromium browser with MV3: Chrome, Edge, Brave, Arc, Vivaldi.

## Connect it

1. On your Maurice server, open **`/admin/tokens`** and create a token — label
   it `web-clipper`, scope `full`. Copy it; it is shown once.
2. Click the extension → **Open settings**.
3. Enter the server address (the same one your Maurice and Carnet apps are
   paired to), paste the token, and **Save & test**.

Chrome will ask for permission to reach that one address. The extension declares
no host permissions up front — it asks for the origin you typed, when you type
it.

## Use it

Click the icon on any article. The popup shows the title, a comment box
(pre-filled with your text selection, if any), and a tags field.
**Cmd/Ctrl+Enter** saves.

If the URL is already in your garden, the popup says so and the button becomes
**Add note** — a second save appends your new comment to the existing fiche
instead of creating a twin.

What lands on the server is one markdown fiche:

```
<garden>/articles/<locale>/<slug>-fiche.md          title, author, publication,
<garden>/articles/<locale>/<slug>-fiche/_fragments/ the full text
<garden>/images/resources/articles/<locale>-<slug>.jpg
```

A short AI summary is written into the frontmatter a few seconds later, by the
server. You do not wait for it.

## How it is wired

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest — `activeTab`, `scripting`, `storage`, and **optional** host permissions |
| `popup.js` | Reads the tab's DOM, checks for a duplicate, collects the note |
| `background.js` | Performs the save, so it survives the popup closing |
| `config.js` | Storage + the API client shared by both |
| `options.js` | Address, token, and the permission request |

Three decisions worth knowing:

**The DOM is read from the popup, never from a content script.** Content scripts
run in the page's own origin, where Chrome enforces CORS and where the page's
own JavaScript could read the token. Extension contexts holding host permission
are exempt from CORS, and the page can see nothing.

**The save runs in the service worker.** A popup is destroyed the instant it
loses focus; a save that took its request with it would abort mid-commit on the
server. The worker finishes either way and reports through the toolbar badge —
`✓` saved, `•` already there, `!` failed.

**The token lives in `chrome.storage.local`, not `sync`.** It is a credential to
a machine you own; syncing it through a Google account would put it somewhere
neither you nor Maurice controls.

## Server side

One endpoint, shared with Carnet's share sheet:

```
POST /api/v1/garden/articles      { url, html?, comment?, tags?, locale, source_client }
GET  /api/v1/garden/articles/lookup?url=…
POST /api/v1/garden/articles/:slug/summary
```

`html` is what makes this extension different from every other caller: when it
is present the server does not fetch, it parses what you sent.

Implementation: `server/data-api/routes/garden-articles.ts` and
`server/data-api/services/garden{Articles,Fiche}.ts`.

## Firefox

The manifest is MV3 and the code uses only `chrome.*` APIs, which Firefox
aliases. It has not been tested there; `background.service_worker` needs to
become `background.scripts` for Firefox's MV3 flavour.
