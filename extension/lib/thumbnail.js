// Makes a small JPEG preview from a screenshot (a data URL). It runs in the
// service worker: it uses OffscreenCanvas, not the DOM.

export const PREVIEW_WIDTH = 480;

function toBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
}

/** Returns a JPEG data URL, at most PREVIEW_WIDTH pixels wide. */
export async function makeThumbnail(dataUrl, { width = PREVIEW_WIDTH, quality = 0.6 } = {}) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, width / bitmap.width);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return `data:image/jpeg;base64,${toBase64(new Uint8Array(await out.arrayBuffer()))}`;
}
