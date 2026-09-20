# Records — phone capture

Photograph a receipt; it lands in a `Records` folder in your own Google
Drive; the desktop app reads it from there.

A static page, not an app. No store listing, no signing keys, no
targetSdk churn, and it works on iPhone.

## Why this rather than a native app

The plan originally called for a Tauri Android app, on the grounds that
it would need no Kotlin and would share the desktop's Rust core.
Neither turned out to be true:

- `cargo check --target aarch64-linux-android` fails in `windows-future`
  before reaching any of our own code. Eleven of the desktop's
  thirty-eight files import the `windows` crate.
- Android WebView does **not** honour `<input type="file" capture>`.
  Getting a camera out of it needs a custom `WebChromeClient`, an
  `ACTION_IMAGE_CAPTURE` intent and a `ValueCallback` — in Kotlin.

The camera works fine in Chrome itself. It is the WebView that is the
problem, not the web platform — so this sidesteps the exact thing that
made the native shell expensive.

What it gives up is background upload. That was never available anyway:
Android 15 caps `dataSync` foreground services at six hours per day,
App Standby disables the network outright for infrequently-used apps,
and the plan's own conclusion was "design the Sync button first".

## Setting it up

### 1. A Web OAuth client

In the **same Google Cloud project as the desktop app** — `drive.file`
grants belong to the project, so a different project cannot see the
same folder.

Google Auth Platform → Clients → Create client → **Web application**.

- **Authorised JavaScript origins**: where you host this page, e.g.
  `https://<user>.github.io`. For local testing add
  `http://localhost:5174`.
- No redirect URI is needed: Google Identity Services returns the token
  to the page.

Copy the client id. There is no secret, and there should not be — a web
client id is public by construction.

### 2. Host it

Any static host. HTTPS is required, not preferred: service workers,
IndexedDB persistence and the camera input all need a secure context.

**Cloudflare Pages or Netlify.** Both are free, both deploy from a
**private** GitHub repo, and both read the `_headers` file in this
folder. Point them at this repository with:

- Build command: *(none)*
- Output directory: `phone`

**GitHub Pages does not work here** on the free plan — it refuses
private repositories, and it can only serve the repository root or
`/docs`, never an arbitrary subfolder. Making the repo public to get
around that would publish the whole application source.

Whichever host, the OAuth client's **authorised JavaScript origin** is
just the scheme and domain (`https://example.pages.dev`), never the
path.

### 3. On the phone

Open the page, paste the client id once, tap **Sign in to Google**, then
**Take a photo**. Add it to the home screen to get a launcher icon and a
full-screen window.

## How it behaves

**The photo is written to IndexedDB before any upload is attempted.**
That ordering is the point: a receipt photographed in a basement with
no signal survives the app closing, the phone locking and the tab being
evicted, because the blob was on disk before the network was ever
consulted.

**Photos are re-encoded before being queued**, to a JPEG with a 2000px
long edge. Three reasons: iPhones shoot HEIC and the desktop's decoder
is built without it, a 12MP photo is a few hundred KB of useful receipt
wrapped in megabytes of nothing, and EXIF rotation has to be baked into
the pixels or the OCR reads a sideways page as noise.

**Uploads are sequential, oldest first.** A weak connection asked for
six parallel uploads tends to time out all six, and going one at a time
means a backgrounded tab loses at most the one in flight.

**Sign-in needs a tap.** Google Identity Services gets a token by
opening a popup — even with `prompt: ""`, which does not silently
re-grant the way the old gapi flow did. A popup with no user gesture
behind it is blocked, so automatic retries check for an existing token
and ask the user rather than trying and failing.

**Nothing sensitive is stored.** The access token lives in memory for
about an hour and is never written to disk. Only the client id (public)
and the Drive folder id (not secret) go to `localStorage`.

## Running it locally

```bash
npx vite phone --port 5174
```

Unit tests for the pure parts — query escaping, filename generation,
queue summaries — run with the repo's own suite:

```bash
npx vitest run phone/
```
