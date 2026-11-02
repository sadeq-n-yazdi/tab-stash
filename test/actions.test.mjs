import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../extension/lib/store.js';
import { collectTabs, saveTabs, openBookmarks } from '../extension/lib/actions.js';
import { fakeStorageArea, fakeChrome } from './fakes.mjs';

const WIN = 1;

function setup(extraTabs = [], opts = {}) {
  const chrome = fakeChrome({
    tabs: [
      { id: 1, windowId: WIN, url: 'https://a.dev', title: 'A', active: true },
      { id: 2, windowId: WIN, url: 'https://b.dev', title: 'B', active: false, pinned: true },
      { id: 3, windowId: WIN, url: 'chrome://newtab/', title: 'New Tab', active: false },
      { id: 4, windowId: WIN, url: 'chrome-extension://abc/manager/manager.html', title: 'Mgr', active: false },
      { id: 5, windowId: WIN, url: '', pendingUrl: 'https://loading.dev', title: '', active: false, groupId: 7 },
      ...extraTabs,
    ],
    ...opts,
  });
  return { chrome, store: createStore(fakeStorageArea()) };
}

test('collectTabs skips blank, own and (optionally) pinned tabs; uses pendingUrl', async () => {
  const { chrome } = setup();
  const ids = async (q) => (await collectTabs(chrome, { windowId: WIN, ...q })).map((t) => t.id);
  assert.deepEqual(await ids({ scope: 'current' }), [1]);
  assert.deepEqual(await ids({ scope: 'window' }), [1, 5]);
  assert.deepEqual(await ids({ scope: 'window', skipPinned: false }), [1, 2, 5]);
  assert.deepEqual(await ids({ scope: 'tabGroup', tabGroupId: 7 }), [5]);
  assert.deepEqual(await ids({ scope: 'tabIds', tabIds: [3, 2] }), [2]);
});

test('saveTabs writes first, then closes, and keeps the window open', async () => {
  const chrome = fakeChrome({ tabs: [
    { id: 1, windowId: WIN, url: 'https://a.dev', title: 'A', active: true },
    { id: 2, windowId: WIN, url: 'https://b.dev', title: 'B', active: false },
  ] });
  const store = createStore(fakeStorageArea());
  const tabs = await collectTabs(chrome, { scope: 'window', windowId: WIN });
  const result = await saveTabs(chrome, store, {
    tabs, target: { newGroup: { name: 'Leisure', color: 'purple' } }, details: { labels: 'learn', note: 'n' },
  });

  assert.equal(result.added, 2);
  assert.equal(result.closed, 2);
  const { bookmarks, groups, settings } = await store.load();
  assert.equal(bookmarks.length, 2);
  assert.ok(bookmarks.every((b) => b.color === 'purple' && b.labels[0] === 'learn' && b.note === 'n'));
  assert.equal(settings.lastGroupId, groups[0].id);
  // A new tab was created before the remove, so the window survives.
  const ops = chrome.state.log.map((l) => l[0]);
  assert.deepEqual(ops, ['create', 'remove']);
  assert.equal(chrome.state.tabs.length, 1);
});

test('saveTabs with close=false leaves tabs open; a title override applies to one tab only', async () => {
  const { chrome, store } = setup();
  const g = await store.addGroup({ name: 'G' });
  const [tab] = await collectTabs(chrome, { scope: 'current', windowId: WIN });
  const r = await saveTabs(chrome, store, { tabs: [tab], target: { groupId: g.id }, details: { title: 'My title' }, close: false });
  assert.equal(r.closed, 0);
  assert.equal(chrome.state.log.length, 0);
  assert.equal((await store.load()).bookmarks[0].title, 'My title');
});

test('saveTabs does not close tabs when the storage write fails', async () => {
  const { chrome, store } = setup();
  const [tab] = await collectTabs(chrome, { scope: 'current', windowId: WIN });
  await assert.rejects(saveTabs(chrome, store, { tabs: [tab], target: { groupId: 'missing' } }));
  assert.equal(chrome.state.log.length, 0);
});

test('openBookmarks opens, groups as a Chrome tab group, reports failures, and removes on restore', async () => {
  const { chrome, store } = setup([], { failUrls: ['chrome://bad'] });
  const g = await store.addGroup({ name: 'Tasks', color: 'red' });
  const { added } = await store.addBookmarks(g.id, [
    { url: 'https://x.dev' }, { url: 'chrome://bad' }, { url: 'https://y.dev' },
  ]);
  const result = await openBookmarks(chrome, store, added, { windowId: WIN, asTabGroup: true, group: g, remove: true });
  assert.equal(result.opened, 2);
  assert.equal(result.failed.length, 1);
  assert.equal(result.removed, 2);
  assert.deepEqual(chrome.state.tabGroups, [{ id: 900, title: 'Tasks', color: 'red' }]);
  const left = (await store.load()).bookmarks.map((b) => b.url);
  assert.deepEqual(left, ['chrome://bad'], 'the failed one stays saved');
});

test('openBookmarks in a new window closes the blank first tab', async () => {
  const { chrome, store } = setup();
  const g = await store.addGroup({ name: 'G' });
  const { added } = await store.addBookmarks(g.id, [{ url: 'https://x.dev' }]);
  await openBookmarks(chrome, store, added, { newWindow: true });
  const win = chrome.state.tabs.filter((t) => t.windowId === 50);
  assert.deepEqual(win.map((t) => t.url), ['https://x.dev']);
});
