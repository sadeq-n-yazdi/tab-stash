// Tests the preview capture of a save in a real browser.
//
// In normal use, the activeTab permission (a click on the icon, a shortcut or
// a menu) lets the extension take the picture. Playwright cannot give
// activeTab, so this test loads a copy of the extension that has access to
// all sites. Only the test copy has this permission.
//
// Usage: node test/smoke-capture.mjs   (part of npm run test:smoke)

import { chromium } from 'playwright';
import http from 'node:http';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const source = fileURLToPath(new URL('../extension', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'tab-stash-capture-'));
const extDir = join(work, 'extension');
cpSync(source, extDir, { recursive: true });
const manifestPath = join(extDir, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.host_permissions = ['<all_urls>'];
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>Colour page</title><body style="margin:0;background:#c03030"><h1>Capture me</h1>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/colour`;

const context = await chromium.launchPersistentContext(join(work, 'profile'), {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});

try {
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extId = new URL(worker.url()).host;

  // The page to save is the visible tab of its own window.
  const manager = await context.newPage();
  await manager.goto(`chrome-extension://${extId}/manager/manager.html`);
  const result = await manager.evaluate(async (url) => {
    const win = await chrome.windows.create({ url, focused: true });
    const [tab] = await chrome.tabs.query({ windowId: win.id });
    for (let i = 0; i < 50; i++) {
      if ((await chrome.tabs.get(tab.id)).status === 'complete') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return chrome.runtime.sendMessage({ type: 'save', scope: 'tabIds', tabIds: [tab.id], windowId: win.id, close: true });
  }, pageUrl);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.result.added, 1);

  const preview = await manager.evaluate(async () => {
    const { createPreviews, indexedDbBackend } = await import('/lib/previews.js');
    const { createStore } = await import('/lib/store.js');
    const { bookmarks } = await createStore(chrome.storage.local).load();
    const found = await createPreviews({ backend: indexedDbBackend() }).get(bookmarks[0].id);
    if (!found) return null;
    const bitmap = await createImageBitmap(await (await fetch(found.image)).blob());
    const canvas = new OffscreenCanvas(1, 1);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, -Math.floor(bitmap.width / 2), -Math.floor(bitmap.height / 2));
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return { scope: found.meta.scope, width: bitmap.width, length: found.image.length, rgb: [r, g, b] };
  });
  assert.ok(preview, 'the save keeps a preview');
  assert.equal(preview.scope, 'local');
  assert.ok(preview.width <= 480, `width ${preview.width}`);
  assert.ok(preview.rgb[0] > 150 && preview.rgb[1] < 100, `the picture shows the red page: ${preview.rgb}`);
  console.log(`✔ a save keeps a preview of the visible tab: ${preview.width} px wide, ${preview.length} characters`);

  // A change of the setting moves the preview (the service worker does it).
  await manager.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, previewScope: 'device' } });
  });
  let moved = null;
  for (let i = 0; i < 50 && !moved?.startsWith('preview:'); i++) {
    moved = await manager.evaluate(async () => {
      const { createPreviews, indexedDbBackend } = await import('/lib/previews.js');
      const { createStore } = await import('/lib/store.js');
      const { bookmarks } = await createStore(chrome.storage.local).load();
      const found = await createPreviews({ backend: indexedDbBackend() }).get(bookmarks[0].id);
      return found?.meta.scope === 'device' ? found.meta.id : null;
    });
    if (!moved) await manager.waitForTimeout(100);
  }
  const device = await worker.evaluate(async () => (await chrome.storage.local.get('device')).device.id);
  assert.ok(moved?.startsWith(`preview:${device}:`), `preview id after the change: ${moved}`);
  console.log('✔ a change of the setting moves the preview to the device space');
  console.log('\nCAPTURE TEST PASSED');
} catch (error) {
  console.error('\nCAPTURE TEST FAILED:', error);
  process.exitCode = 1;
} finally {
  await context.close();
  server.close();
  rmSync(work, { recursive: true, force: true });
}
