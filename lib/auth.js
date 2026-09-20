// Signing in to Google, from a page with no server behind it.
//
// The desktop does the full PKCE dance and keeps a refresh token for
// months. A browser cannot: anything it stores is readable by any
// script that ends up on the page, and Google does not issue refresh
// tokens to browser clients for exactly that reason. So this side uses
// Google Identity Services' token model - an access token that lives
// about an hour, held in memory only, never written to storage.
//
// That sounds worse than it is. The token is re-requested on load, and
// once the user has granted the scope the re-grant is silent - no
// consent screen, no tap. What it costs is that the page must be open
// to upload, which was already true: this is a capture app, and
// background upload on Android is not something an indie app gets.

const GIS = "https://accounts.google.com/gsi/client";
export const SCOPE = "https://www.googleapis.com/auth/drive.file";

/** Not a secret - a web OAuth client id is public by construction. */
const CLIENT_ID_KEY = "records.clientId";

export function storedClientId() {
  return localStorage.getItem(CLIENT_ID_KEY) || "";
}

export function storeClientId(id) {
  localStorage.setItem(CLIENT_ID_KEY, id.trim());
}

let scriptLoaded = null;

function loadGis() {
  if (scriptLoaded) return scriptLoaded;
  scriptLoaded = new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = GIS;
    el.async = true;
    el.onload = resolve;
    el.onerror = () => reject(new Error("Could not reach Google to sign in."));
    document.head.appendChild(el);
  });
  return scriptLoaded;
}

let tokenClient = null;
let token = null;
let expiresAt = 0;

/** Thrown when a token is needed but only a real tap can get one. */
export class NeedsSignIn extends Error {
  constructor() {
    super("Sign in to send these.");
    this.name = "NeedsSignIn";
  }
}

/**
 * An access token.
 *
 * `interactive` is not an optimisation, it is a hard requirement.
 * Google Identity Services gets a token by opening a **popup** - even
 * with `prompt: ""`, which does not do a silent iframe re-grant the
 * way the older gapi flow did. A popup without a user gesture behind
 * it is blocked by every browser, so calling this from a background
 * retry does not merely annoy the user, it fails. Hence: only the
 * sign-in button ever passes `interactive`, and everything else has to
 * cope with being told no.
 */
export async function accessToken({ interactive = false } = {}) {
  // Sixty seconds of slack: a token that expires mid-upload fails the
  // request, and a large photo can be in flight for a while.
  if (token && Date.now() < expiresAt - 60_000) return token;
  if (!interactive) throw new NeedsSignIn();

  const clientId = storedClientId();
  if (!clientId) throw new Error("No Google client id set yet.");

  await loadGis();
  if (!tokenClient) {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: () => {},
    });
  }

  return new Promise((resolve, reject) => {
    // A popup that fails to open reports through error_callback and
    // NEVER through callback. Without this the promise never settles,
    // and whatever awaited it is wedged for the life of the page -
    // which, for the upload loop, means its in-progress flag is stuck
    // on and no later upload can ever start.
    tokenClient.error_callback = (e) => reject(new Error(describeAuthError(e?.type)));
    tokenClient.callback = (response) => {
      if (response.error) {
        reject(new Error(describeAuthError(response.error)));
        return;
      }
      token = response.access_token;
      expiresAt = Date.now() + Number(response.expires_in || 3600) * 1000;
      resolve(token);
    };
    try {
      // Not "consent": that re-asks someone who already said yes every
      // single time. Empty means "ask only if you have to", and the
      // popup closes by itself when the scope is already granted.
      tokenClient.requestAccessToken({ prompt: "" });
    } catch (e) {
      reject(e);
    }
  });
}

export function forgetToken() {
  token = null;
  expiresAt = 0;
}

export function haveToken() {
  return Boolean(token) && Date.now() < expiresAt;
}

function describeAuthError(code) {
  switch (code) {
    case "popup_closed":
      return "The Google sign-in window was closed before it finished.";
    case "popup_failed_to_open":
      return "Your browser blocked the Google sign-in window. Allow pop-ups for this page.";
    case "access_denied":
      return "Sign-in was refused. Records can only see the folder it creates.";
    default:
      return `Google refused the sign-in (${code}).`;
  }
}
