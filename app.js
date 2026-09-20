// Records capture, for a phone.
//
// The whole app: point the camera at a receipt, it lands in the user's
// own Google Drive, the desktop reads it from there. No account of
// ours, no server of ours, and nothing on this page ever sees a
// document after it is uploaded.
//
// The ordering that matters, and the reason for most of the code
// below: capture writes to IndexedDB FIRST, then uploads. Never the
// other way round. Backgrounding a browser tab kills in-flight
// requests, and a receipt that only existed inside a fetch() is gone.

import {
  accessToken,
  forgetClientId,
  forgetToken,
  haveToken,
  storedClientId,
  storeClientId,
} from "./lib/auth.js";
import { ensureFolder, upload } from "./lib/drive.js";
import { normalize, captureName } from "./lib/normalize.js";
import * as queue from "./lib/queue.js";

const FOLDER_KEY = "records.folderId";

const el = (id) => document.getElementById(id);
const ui = {
  setup: el("setup"),
  capture: el("capture"),
  clientId: el("clientId"),
  saveClient: el("saveClient"),
  signIn: el("signIn"),
  shoot: el("shoot"),
  pick: el("pick"),
  status: el("status"),
  list: el("list"),
  retry: el("retry"),
  changeClient: el("changeClient"),
  activeClient: el("activeClient"),
};

let draining = false;

/**
 * A message that outranks the queue's own summary.
 *
 * Without this, render() runs in drain()'s `finally` and overwrites
 * whatever drain() was trying to say - so "tap Sign in to send"
 * becomes a bare "1 waiting", and the one instruction the user needed
 * is the one thing they never see.
 */
let notice = null;

// ---------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------

function say(message, kind = "") {
  ui.status.textContent = message;
  ui.status.className = `status ${kind}`;
}

async function render() {
  const rows = await queue.all();
  const outstanding = rows.filter((r) => r.status !== queue.SENT);

  ui.list.innerHTML = "";
  for (const row of outstanding.slice().reverse()) {
    const li = document.createElement("li");
    li.className = `shot ${row.status}`;
    const name = document.createElement("span");
    name.className = "shot-name";
    name.textContent = row.name;
    const state = document.createElement("span");
    state.className = "shot-state";
    state.textContent = row.status === queue.FAILED ? row.error || "failed" : "waiting";
    li.append(name, state);
    ui.list.append(li);
  }

  ui.retry.hidden = !outstanding.some((r) => r.status === queue.FAILED);
  if (notice) say(notice.message, notice.kind);
  else if (outstanding.length === 0) say("Everything is in Drive", "ok");
  else say(queue.describe(outstanding));
}

// ---------------------------------------------------------------
// Capture
// ---------------------------------------------------------------

async function accept(files) {
  if (!files?.length) return;
  const now = new Date();
  let seq = 0;
  for (const file of files) {
    try {
      // Re-encoded before queueing, not before uploading: the queue
      // then holds a blob the desktop is known to be able to read, and
      // a retry never re-does the expensive part.
      const blob = await normalize(file);
      await queue.add(captureName(now, seq++), blob);
    } catch (e) {
      notice = { message: `Could not read that photo: ${e.message}`, kind: "bad" };
      await render();
      return;
    }
  }
  await render();
  void drain();
}

// ---------------------------------------------------------------
// Upload
// ---------------------------------------------------------------

/**
 * Send everything outstanding, oldest first.
 *
 * One at a time and awaited, never fired off in parallel: a phone on a
 * weak connection uploading six photos at once tends to time out all
 * six, and sequential means a backgrounded tab loses at most the one
 * in flight.
 */
async function drain() {
  if (draining) return;
  draining = true;
  notice = null;
  try {
    let rows = await queue.pending();
    if (!rows.length) return;
    if (!navigator.onLine) {
      notice = { message: `${rows.length} waiting for a connection`, kind: "" };
      return;
    }

    // Checked rather than attempted. Asking for a token opens a popup,
    // and a popup with no tap behind it is blocked - so an automatic
    // drain must never even try.
    if (!haveToken()) {
      notice = { message: `${rows.length} waiting - tap Sign in to send`, kind: "" };
      ui.signIn.hidden = false;
      return;
    }
    let token = await accessToken();

    let folderId = localStorage.getItem(FOLDER_KEY) || "";
    folderId = await ensureFolder(token, folderId);
    localStorage.setItem(FOLDER_KEY, folderId);

    for (const row of rows) {
      say(`Sending ${row.name}...`);
      try {
        await upload(token, folderId, row.name, row.blob);
        // Removed rather than marked sent: the desktop is the archive,
        // and keeping every photo here forever would fill the phone
        // with a second copy of everything.
        await queue.remove(row.id);
      } catch (e) {
        if (e.message === "expired") {
          // Cannot quietly get another: that needs a popup, which
          // needs a tap. The photo stays pending and untouched, so
          // pressing Sign in resumes exactly where this stopped.
          forgetToken();
          ui.signIn.hidden = false;
          notice = { message: "Signed out by Google - tap Sign in to carry on", kind: "" };
          return;
        }
        await queue.markFailed(row.id, e.message);
      }
      await render();
    }
  } catch (e) {
    notice = { message: e.message, kind: "bad" };
  } finally {
    draining = false;
    await render();
  }
}

// ---------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------

ui.saveClient.addEventListener("click", () => {
  const value = ui.clientId.value.trim();
  if (!value.endsWith(".apps.googleusercontent.com")) {
    say("That does not look like a Google client id.", "bad");
    return;
  }
  storeClientId(value);
  showCapture();
  showActiveClient();
  say("Ready. Tap Sign in.");
});

ui.signIn.addEventListener("click", async () => {
  try {
    say("Signing in...");
    await accessToken({ interactive: true });
    ui.signIn.hidden = true;
    notice = null;
    void drain();
  } catch (e) {
    notice = { message: e.message, kind: "bad" };
    // A client id Google does not recognise can only be fixed by
    // entering a different one, and the setup panel is hidden the
    // moment any id is saved - so without this the page is stuck
    // showing an error about a value there is no way to change.
    if (/client id/i.test(e.message)) showSetup();
    await render();
  }
});

// Always available, not only after a failure: an id that is merely the
// WRONG one - a client from another project, say - fails later at the
// Drive call rather than at sign-in, and the page must still be
// correctable then.
/** The id currently in use, shown so it can be compared without guessing. */
function showActiveClient() {
  const id = storedClientId();
  if (!ui.activeClient) return;
  // Not a secret: a web client id is public by construction, and it is
  // printed in full because the useful part is the segment after the
  // project prefix, which every client in a project shares.
  ui.activeClient.textContent = id ? `Using ${id}` : "";
}

ui.changeClient.addEventListener("click", () => {
  forgetClientId();
  showSetup();
  say("Paste the Web client id for your Google Cloud project.");
});

ui.shoot.addEventListener("change", (e) => void accept(e.target.files).then(() => (e.target.value = "")));
ui.pick.addEventListener("change", (e) => void accept(e.target.files).then(() => (e.target.value = "")));
ui.retry.addEventListener("click", async () => {
  for (const row of await queue.all()) {
    if (row.status === queue.FAILED) await queue.markPending(row.id);
  }
  await render();
  void drain();
});

// Coming back to a backgrounded tab is the single most likely moment
// for an interrupted upload to be resumable, so retry then rather than
// waiting for the user to notice.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void drain();
});
window.addEventListener("online", () => void drain());

function showCapture() {
  ui.setup.hidden = true;
  ui.capture.hidden = false;
  showActiveClient();
}

function showSetup() {
  ui.setup.hidden = false;
  ui.capture.hidden = true;
  ui.clientId.value = storedClientId();
}

async function start() {
  if (storedClientId()) {
    showCapture();
    ui.clientId.value = storedClientId();
    ui.signIn.hidden = haveToken();
  }
  await render();
  if (storedClientId()) void drain();
  if ("serviceWorker" in navigator) {
    // Only so the page opens without a connection. It caches the shell
    // and nothing else - photos live in IndexedDB, which survives on
    // its own.
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

void start();
