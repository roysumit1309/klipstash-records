// The outbox.
//
// A photo is written here BEFORE any upload is attempted, and only
// removed once Drive has confirmed it. That ordering is the whole
// point: a receipt photographed in a restaurant basement with no
// signal has to survive the app being closed, the phone being locked,
// and the browser tab being evicted - and it does, because the blob is
// in IndexedDB before the network is ever consulted.
//
// Every comparable receipt app has this except Wave, and neither of
// the good Paperless Android clients does. It is the difference
// between "works on good wifi" and "works".

const DB_NAME = "records-outbox";
const STORE = "shots";
const VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req?.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

/** Statuses a queued shot can hold. */
export const PENDING = "pending";
export const SENT = "sent";
export const FAILED = "failed";

export function add(name, blob) {
  return tx(STORE, "readwrite", (s) =>
    s.add({ name, blob, status: PENDING, attempts: 0, addedAt: Date.now() }),
  );
}

export function all() {
  return tx(STORE, "readonly", (s) => s.getAll());
}

export async function pending() {
  return (await all()).filter((r) => r.status !== SENT);
}

export function remove(id) {
  return tx(STORE, "readwrite", (s) => s.delete(id));
}

/**
 * Record an attempt that did not land.
 *
 * Attempts are counted but never used to give up permanently. A failed
 * upload is almost always a flat network rather than a bad file, and
 * silently dropping someone's receipt because it failed five times in
 * a tunnel would be the worst thing this app could do.
 */
export async function markFailed(id, error) {
  const row = await tx(STORE, "readonly", (s) => s.get(id));
  if (!row) return;
  row.status = FAILED;
  row.attempts = (row.attempts || 0) + 1;
  row.error = String(error).slice(0, 200);
  await tx(STORE, "readwrite", (s) => s.put(row));
}

export async function markPending(id) {
  const row = await tx(STORE, "readonly", (s) => s.get(id));
  if (!row) return;
  row.status = PENDING;
  delete row.error;
  await tx(STORE, "readwrite", (s) => s.put(row));
}

/** How the queue should be summarised in one line. */
export function describe(rows) {
  const waiting = rows.filter((r) => r.status === PENDING).length;
  const failed = rows.filter((r) => r.status === FAILED).length;
  if (!waiting && !failed) return "Everything is in Drive";
  const parts = [];
  if (waiting) parts.push(`${waiting} waiting`);
  if (failed) parts.push(`${failed} to retry`);
  return parts.join(", ");
}
