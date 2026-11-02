// End-to-end smoke test: loads the unpacked extension in Chromium and checks
// that the service worker starts, that saving closes tabs, that the manager
// and popup render without errors, and that "Restore all" reopens the tabs.
//
// Usage: npm run test:smoke   (needs: npx playwright install chromium)
// Set SCREENSHOTS=dir to save screenshots of the popup and the manager.

import { chromium } from 'playwright';
import http from 'node:http';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { hasGo, startGoServer, TEST_PASSWORD } from './go-server.mjs';

const extDir = fileURLToPath(new URL('../extension', import.meta.url));
const shots = process.env.SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });

const server = http.createServer((req, res) => {
  const name = req.url.slice(1) || 'home';
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>Page ${name}</title><h1>${name}</h1>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = mkdtempSync(join(tmpdir(), 'tab-stash-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});

const errors = [];
const watch = (page, label) => {
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`); });
};

try {
  // 1. Service worker starts and creates the default group.
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extId = new URL(worker.url()).host;
  const extUrl = (p) => `chrome-extension://${extId}/${p}`;
  // The "key" in manifest.json fixes the ID, whatever the folder is.
  assert.equal(extId, 'icppdneajfbmmpkgejjpjfegkppmneej', 'extension ID must not depend on the folder');
  console.log('✔ service worker started with the fixed ID:', extId);

  await worker.evaluate(async () => {
    for (let i = 0; i < 50; i++) {
      const all = await chrome.storage.local.get(null);
      if (Object.keys(all).some((k) => k.startsWith('g:'))) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Inbox group was not created');
  });
  console.log('✔ default group created');

  const shortcuts = Object.fromEntries(
    await worker.evaluate(async () => (await chrome.commands.getAll()).map((c) => [c.name, c.shortcut])),
  );
  for (const name of ['_execute_action', 'quick-save-tab', 'save-window', 'open-manager']) {
    assert.ok(shortcuts[name], `shortcut for ${name} should be assigned: ${JSON.stringify(shortcuts)}`);
  }
  console.log('✔ shortcuts assigned:', JSON.stringify(shortcuts));

  // 2. Open three web pages in one window.
  const first = context.pages()[0] ?? (await context.newPage());
  await first.goto(`${base}/one`);
  for (const name of ['two', 'three']) await (await context.newPage()).goto(`${base}/${name}`);

  // 3. Save the whole window into a new group through the service worker.
  const manager = await context.newPage();
  watch(manager, 'manager');
  await manager.goto(extUrl('manager/manager.html'));
  const result = await manager.evaluate(async () => {
    const win = await chrome.windows.getCurrent();
    return chrome.runtime.sendMessage({
      type: 'save', scope: 'window', windowId: win.id,
      target: { newGroup: { name: 'Leisure reading', color: 'purple' } },
      details: { labels: ['learn', 'deep-dive'], note: 'weekend' }, close: true,
    });
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.result.added, 3);
  console.log('✔ saved 3 tabs:', JSON.stringify(result.result));

  const openWeb = () => context.pages().filter((p) => p.url().startsWith(base)).length;
  for (let i = 0; i < 30 && openWeb() > 0; i++) await manager.waitForTimeout(100);
  assert.equal(openWeb(), 0, 'web tabs should be closed');
  console.log('✔ tabs closed, manager tab still open');

  // 4. The manager shows the group and its bookmarks.
  await manager.locator('.group-list button', { hasText: 'Leisure reading' }).click();
  await manager.locator('.bookmark').first().waitFor();
  assert.deepEqual(await manager.locator('.bookmark .title').allTextContents(), ['Page one', 'Page two', 'Page three']);
  assert.equal(await manager.locator('.label-filter .chip').count(), 2);
  console.log('✔ manager lists 3 bookmarks with 2 labels');

  // A save without the activeTab grant has no preview: the save still works.
  assert.equal(await manager.locator('.preview-btn').count(), 0, 'no preview without activeTab');

  // Previews: make a picture with the real thumbnail code, keep it for
  // "Page two", and show it. (Headless Chromium cannot grant activeTab, so
  // the screenshot itself is not tested here.)
  const thumb = await manager.evaluate(async () => {
    const canvas = new OffscreenCanvas(1600, 1000);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#3366cc';
    ctx.fillRect(0, 0, 1600, 1000);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(100, 100, 600, 300);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const raw = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
    const { makeThumbnail } = await import('/lib/thumbnail.js');
    const image = await makeThumbnail(raw);
    const bitmap = await createImageBitmap(await (await fetch(image)).blob());
    return { prefix: image.slice(0, 23), length: image.length, width: bitmap.width, height: bitmap.height };
  });
  assert.equal(thumb.prefix, 'data:image/jpeg;base64,');
  assert.deepEqual([thumb.width, thumb.height], [480, 300]);
  assert.ok(thumb.length < 60_000, `thumbnail of ${thumb.length} characters`);
  console.log(`✔ thumbnail: ${thumb.width}x${thumb.height}, ${thumb.length} characters`);

  await manager.evaluate(async () => {
    const { createPreviews, indexedDbBackend } = await import('/lib/previews.js');
    const { makeThumbnail } = await import('/lib/thumbnail.js');
    const canvas = new OffscreenCanvas(800, 500);
    canvas.getContext('2d').fillRect(0, 0, 800, 500);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const raw = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
    const { load } = await import('/lib/store.js').then(({ createStore }) => createStore(chrome.storage.local));
    const { bookmarks } = await load();
    const two = bookmarks.find((b) => b.title === 'Page two');
    await createPreviews({ backend: indexedDbBackend() }).save(two.id, await makeThumbnail(raw), { scope: 'local' });
  });
  const previewBtn = manager.locator('.bookmark', { hasText: 'Page two' }).locator('.preview-btn');
  await previewBtn.waitFor({ timeout: 5_000 });
  await previewBtn.click();
  await manager.locator('#preview-dialog[open]').waitFor();
  assert.ok(await manager.locator('#preview-image').evaluate((img) => img.complete && img.naturalWidth === 480));
  assert.match(await manager.locator('#preview-info').textContent(), /only on this computer/);
  if (shots) await manager.screenshot({ path: join(shots, 'manager-preview.png') });
  await manager.locator('#preview-close').click();
  console.log('✔ the manager shows the preview of a bookmark');

  // Search filters the list.
  await manager.fill('#search', 'Page two');
  assert.equal(await manager.locator('.bookmark').count(), 1);
  await manager.fill('#search', '');
  if (shots) await manager.screenshot({ path: join(shots, 'manager.png'), fullPage: true });

  // Edit a bookmark note through the dialog.
  await manager.locator('.bookmark', { hasText: 'Page one' }).getByRole('button', { name: 'Edit' }).click();
  await manager.fill('#edit-form textarea[name="note"]', 'read the intro first');
  await manager.locator('#edit-form button[value="save"]').click();
  await manager.locator('.bookmark .note', { hasText: 'read the intro first' }).waitFor();
  console.log('✔ edit dialog saves a note');

  // 5. Restore all: tabs reopen in a Chrome tab group, bookmarks are removed.
  await manager.getByRole('button', { name: 'Restore all' }).click();
  for (let i = 0; i < 30 && openWeb() < 3; i++) await manager.waitForTimeout(100);
  assert.equal(openWeb(), 3, 'tabs should reopen');
  const grouped = await manager.evaluate(async () => {
    const groups = await chrome.tabGroups.query({});
    return groups.map((g) => ({ title: g.title, color: g.color }));
  });
  assert.deepEqual(grouped, [{ title: 'Leisure reading', color: 'purple' }]);
  await manager.locator('#empty').waitFor({ state: 'visible' });
  console.log('✔ restore reopened 3 tabs as tab group', JSON.stringify(grouped[0]));

  // Restore removes the bookmarks, and the service worker removes their previews.
  let livePreviews = -1;
  for (let i = 0; i < 30 && livePreviews !== 0; i++) {
    livePreviews = await manager.evaluate(async () => {
      const { createPreviews, indexedDbBackend } = await import('/lib/previews.js');
      return (await createPreviews({ backend: indexedDbBackend() }).bookmarkIds()).size;
    });
    if (livePreviews) await manager.waitForTimeout(100);
  }
  assert.equal(livePreviews, 0, 'the preview of a removed bookmark is removed');
  const device = await worker.evaluate(async () => (await chrome.storage.local.get('device')).device);
  assert.match(device?.id ?? '', /^[0-9a-f-]{36}$/);
  console.log('✔ previews of removed bookmarks are removed; device ID', device.id);

  // 6. The popup page renders and lists groups.
  const popup = await context.newPage();
  watch(popup, 'popup');
  await popup.setViewportSize({ width: 380, height: 640 });
  await popup.goto(extUrl('popup/popup.html'));
  await popup.locator('#group-select option', { hasText: 'Leisure reading' }).waitFor({ state: 'attached' });
  assert.ok((await popup.locator('#group-select option').count()) >= 3);
  // Here the popup runs in its own tab, so "This tab" is the popup page itself.
  // Select "All tabs in window" for a screenshot without that page's details.
  await popup.locator('input[name="scope"][value="window"]').check();
  assert.ok(await popup.locator('#page-info').isHidden());
  if (shots) await popup.screenshot({ path: join(shots, 'popup.png') });
  console.log('✔ popup renders with groups');

  // 7. Connect to a sync server from the manager (needs Go to build it).
  if (hasGo) {
    const sync = await startGoServer({ users: ['alice'] });
    try {
      await manager.bringToFront();
      // Headless Chromium shows the host permission prompt and nobody can
      // answer it. Answer "deny": login must work without it, through CORS.
      await manager.evaluate(() => { chrome.permissions.request = async () => false; });
      await manager.locator('#sync-connect').click();
      await manager.locator('#sync-form [name="serverUrl"]').fill(sync.url);
      await manager.locator('#sync-form [name="username"]').fill('alice');
      await manager.locator('#sync-form [name="password"]').fill(TEST_PASSWORD);
      await manager.locator('#sync-login').click();
      await manager.locator('#sync-status', { hasText: 'Logged in as' }).waitFor({ timeout: 15_000 });
      assert.ok(await manager.locator('#sync-dialog').evaluate((d) => !d.open), 'the dialog closes');
      const login = await fetch(`${sync.url}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'alice', password: TEST_PASSWORD, client: 'smoke' }),
      }).then((r) => r.json());
      const pulled = await fetch(`${sync.url}/api/v1/sync?since=0`, {
        headers: { authorization: `Bearer ${login.token}` },
      }).then((r) => r.json());
      const names = pulled.records.filter((r) => r.kind === 'group' && !r.deletedAt).map((r) => r.name).sort();
      assert.ok(names.includes('Leisure reading'), `server has the groups: ${JSON.stringify(names)}`);
      // Another computer adds a group. When the manager opens again and the
      // last sync is old, the manager shows the new group.
      const now = new Date().toISOString();
      const pushed = await fetch(`${sync.url}/api/v1/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}` },
        body: JSON.stringify({ records: [{
          id: 'remote-group', kind: 'group', name: 'From the other computer', note: '', labels: [],
          color: 'cyan', createdAt: now, updatedAt: now, deletedAt: null,
        }] }),
      }).then((r) => r.json());
      assert.equal(pushed.accepted, 1, JSON.stringify(pushed));
      await worker.evaluate(async () => {
        const { sync } = await chrome.storage.local.get('sync');
        await chrome.storage.local.set({ sync: { ...sync, lastSyncAt: new Date(Date.now() - 120_000).toISOString() } });
      });
      await manager.reload();
      await manager.locator('#group-list', { hasText: 'From the other computer' }).waitFor({ timeout: 15_000 });
      console.log('✔ opening the manager gets the changes of another computer');
      if (shots) await manager.screenshot({ path: join(shots, 'manager-sync.png') });
      console.log(`✔ sync connected from the manager; server has ${pulled.records.length} records`);
    } finally {
      sync.stop();
    }
  } else {
    console.log('- sync step skipped: Go is not installed');
  }

  assert.deepEqual(errors, [], 'no page errors');
  console.log('\nSMOKE TEST PASSED');
} catch (error) {
  console.error('\nSMOKE TEST FAILED:', error);
  if (errors.length) console.error('Page errors:', errors);
  process.exitCode = 1;
} finally {
  await context.close();
  server.close();
  rmSync(profile, { recursive: true, force: true });
}
