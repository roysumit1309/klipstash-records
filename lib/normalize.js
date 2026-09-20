// Turning whatever the camera handed over into something the desktop
// can actually read.
//
// Three problems, one fix:
//
// 1. **HEIC.** iPhones shoot it, and the desktop's image decoder is
//    built without HEIC support - so an untouched upload would sit in
//    Drive being skipped forever, which looks exactly like nothing
//    happening. Safari can DECODE heic even though the desktop cannot,
//    so re-encoding here is the only place the conversion can happen
//    without shipping a decoder.
// 2. **Size.** A modern phone photo is 3-12 MB. A receipt does not
//    need that, the user's Drive quota does not want it, and every one
//    of those megabytes crosses a mobile connection twice.
// 3. **Rotation.** EXIF orientation is metadata, not pixels. Drawing
//    to a canvas discards it, so a photo taken in portrait arrives
//    sideways and the OCR reads nothing - the engine's own word boxes
//    are only valid at TextAngle 0.

/**
 * Long side of the re-encoded image.
 *
 * 2000px keeps a receipt's text well above the ~48px line height the
 * OCR wants while cutting a 12MP photo to a few hundred KB. Going
 * smaller starts eating thermal-printer strokes.
 */
const MAX_EDGE = 2000;
const QUALITY = 0.85;

/**
 * Re-encode a captured file as a right-way-up JPEG.
 *
 * `imageOrientation: "from-image"` is what applies the EXIF rotation
 * to the pixels; without it the bitmap is the raw sensor data and the
 * rotation is silently lost.
 */
export async function normalize(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  // Receipts are mostly white; without this, any part of the canvas
  // the image does not cover encodes as black in a JPEG.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("could not re-encode that photo"))),
      "image/jpeg",
      QUALITY,
    ),
  );
  return blob;
}

/**
 * A filename that sorts by capture time and never collides.
 *
 * The desktop ingests by content hash and does not care what a file is
 * called, but a human opening the Drive folder does - and two photos
 * taken in the same second must not overwrite each other.
 */
export function captureName(date, seq) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `record-${stamp}-${p(seq, 3)}.jpg`;
}
