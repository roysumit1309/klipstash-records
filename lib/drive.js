// Talking to Google Drive from a browser.
//
// Deliberately mirrors crates/drive-core/src/api.rs: the same folder
// name, the same query shape, the same quote escaping. The two halves
// have to agree on where the folder is and what it is called, and the
// cheapest way to keep them agreeing is to write them to look alike.
//
// What is NOT mirrored is the auth: the desktop holds a refresh token
// in Credential Manager, a browser cannot hold one safely at all, so
// this side uses short-lived access tokens and asks again.

const FILES = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

export const FOLDER_MIME = "application/vnd.google-apps.folder";

/** Must match FOLDER_NAME in drive-core, or the two halves use different folders. */
export const FOLDER_NAME = "Records";

/**
 * Escape a value going into a Drive query literal.
 *
 * Query literals are single-quoted, so an unescaped quote ends the
 * literal early and changes what the query means.
 */
export function escapeLiteral(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function folderQuery(name) {
  return `mimeType='${FOLDER_MIME}' and name='${escapeLiteral(name)}' and trashed=false`;
}

/**
 * Pick a file extension from the blob's own type.
 *
 * Phone cameras hand over a File whose name may be anything at all -
 * "image.jpg" for a HEIC, or no extension. The type is what the
 * browser actually determined.
 */
export function extensionFor(mime) {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/heic":
    case "image/heif":
      return "heic";
    default:
      return "jpg";
  }
}

/**
 * Whether the desktop will be able to read this.
 *
 * Mirrors is_ingestable() in drive-core. HEIC is the one that matters:
 * iPhones produce it, Android sometimes does, and the desktop's image
 * decoder is built without it - so uploading one means it lands in
 * Drive and is silently skipped forever. Better to convert first.
 */
export function isIngestable(mime) {
  return ["image/jpeg", "image/png", "image/webp", "image/bmp", "image/gif"].includes(mime);
}

async function call(token, url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    // 401 is worth naming: it means the hour-long access token expired,
    // which the caller can fix by asking for another one rather than
    // showing the user an error they cannot act on.
    const err = new Error(
      response.status === 401
        ? "expired"
        : `Drive returned ${response.status}: ${body.slice(0, 200)}`,
    );
    err.status = response.status;
    throw err;
  }
  return response;
}

/** Find the Records folder, creating it on first run. */
export async function ensureFolder(token, cachedId) {
  if (cachedId) {
    try {
      const probe = await call(token, `${FILES}/${cachedId}?fields=id,trashed`);
      const json = await probe.json();
      if (!json.trashed) return cachedId;
    } catch (e) {
      // A 401 means the token is stale, not that the folder is gone -
      // re-searching would be wrong AND would fail the same way.
      if (e.status === 401) throw e;
    }
  }
  const q = encodeURIComponent(folderQuery(FOLDER_NAME));
  const found = await (
    await call(token, `${FILES}?q=${q}&fields=files(id)&pageSize=10&spaces=drive`)
  ).json();
  if (found.files?.length) return found.files[0].id;

  const created = await (
    await call(token, `${FILES}?fields=id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
    })
  ).json();
  return created.id;
}

/**
 * Put one photo in the folder.
 *
 * Two requests rather than one multipart/related body, matching the
 * desktop: the boundary handling in hand-rolled multipart is the usual
 * source of silently corrupted uploads, and an extra round trip costs
 * nothing on a path that runs once per photo.
 */
export async function upload(token, folderId, name, blob) {
  const created = await (
    await call(token, `${FILES}?fields=id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, parents: [folderId] }),
    })
  ).json();

  await call(token, `${UPLOAD}/${created.id}?uploadType=media`, {
    method: "PATCH",
    headers: { "Content-Type": blob.type || "image/jpeg" },
    body: blob,
  });
  return created.id;
}
