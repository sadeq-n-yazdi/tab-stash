import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../extension/lib/store.js';
import { parseImport } from '../extension/lib/model.js';
import { fakeStorageArea } from './fakes.mjs';

test('each record is stored under its own key', async () => {
  const area = fakeStorageArea();
  const store = createStore(area);
  const g = await store.addGroup({ name: 'Read later', color: 'blue' });
  await store.addBookmarks(g.id, [{ url: 'https://a', title: 'A' }, { url: 'https://b', title: 'B' }]);
  const keys = [...area.data.keys()].sort();
  assert.equal(keys.filter((k) => k.startsWith('g:')).length, 1);
  assert.equal(keys.filter((k) => k.startsWith('b:')).length, 2);
});

test('addBookmarks skips URLs already in the group and inherits the group colour', async () => {
  const store = createStore(fakeStorageArea());
  const g = await store.addGroup({ name: 'G', color: 'green' });
  const first = await store.addBookmarks(g.id, [{ url: 'https://a' }, { url: 'https://a' }]);
  assert.equal(first.added.length, 1);
  assert.equal(first.duplicates, 1);
  assert.equal(first.added[0].color, 'green');
  const second = await store.addBookmarks(g.id, [{ url: 'https://a' }, { url: 'https://b', color: 'red' }]);
  assert.equal(second.added.length, 1);
  assert.equal(second.added[0].color, 'red');
});

test('deleteGroup hides the group and its bookmarks; purge removes old tombstones', async () => {
  const area = fakeStorageArea();
  const store = createStore(area);
  const g = await store.addGroup({ name: 'G' });
  const keep = await store.addGroup({ name: 'Keep' });
  await store.addBookmarks(g.id, [{ url: 'https://a' }]);
  await store.addBookmarks(keep.id, [{ url: 'https://k' }]);
  assert.equal(await store.deleteGroup(g.id), 1);

  const live = await store.load();
  assert.deepEqual(live.groups.map((x) => x.name), ['Keep']);
  assert.equal(live.bookmarks.length, 1);
  assert.equal((await store.load({ includeDeleted: true })).groups.length, 2, 'tombstones are kept for sync');

  assert.equal(await store.purgeDeleted(30), 0, 'recent tombstones stay');
  assert.equal(await store.purgeDeleted(30, Date.now() + 31 * 86_400_000), 2);
  assert.equal(area.data.size, 2);
});

test('updateBookmark can move to another group but not to a missing one', async () => {
  const store = createStore(fakeStorageArea());
  const a = await store.addGroup({ name: 'A' });
  const b = await store.addGroup({ name: 'B' });
  const { added: [bm] } = await store.addBookmarks(a.id, [{ url: 'https://x' }]);
  const moved = await store.updateBookmark(bm.id, { groupId: b.id, note: 'later' });
  assert.equal(moved.groupId, b.id);
  assert.equal(moved.note, 'later');
  await assert.rejects(store.updateBookmark(bm.id, { groupId: 'missing' }), /Target group/);
});

test('ensureDefaultGroup creates Inbox once and remembers it', async () => {
  const store = createStore(fakeStorageArea());
  const g1 = await store.ensureDefaultGroup();
  const g2 = await store.ensureDefaultGroup();
  assert.equal(g1.name, 'Inbox');
  assert.equal(g1.id, g2.id);
  assert.equal((await store.getSettings()).lastGroupId, g1.id);
});

test('export then import into an empty store restores everything; re-import changes nothing', async () => {
  const src = createStore(fakeStorageArea());
  const g = await src.addGroup({ name: 'G', labels: ['x'] });
  await src.addBookmarks(g.id, [{ url: 'https://a', note: 'n', labels: ['y'] }]);
  const file = JSON.stringify(await src.exportData());

  const dst = createStore(fakeStorageArea());
  assert.deepEqual(await dst.importData(parseImport(file)), { groups: 1, bookmarks: 1, skipped: 0 });
  const loaded = await dst.load();
  assert.equal(loaded.bookmarks[0].note, 'n');
  assert.deepEqual(await dst.importData(parseImport(file)), { groups: 0, bookmarks: 0, skipped: 0 });
});

test('a batch keeps its tab order in the newest-first list', async () => {
  const store = createStore(fakeStorageArea());
  const g = await store.addGroup({ name: 'G' });
  await store.addBookmarks(g.id, [{ url: 'https://1' }, { url: 'https://2' }, { url: 'https://3' }]);
  assert.deepEqual((await store.load()).bookmarks.map((b) => b.url), ['https://1', 'https://2', 'https://3']);
});

test('import skips bookmarks whose group is unknown', async () => {
  const store = createStore(fakeStorageArea());
  const data = {
    format: 'tab-shelf', version: 1, groups: [],
    bookmarks: [{ id: 'b1', groupId: 'nope', url: 'https://a', createdAt: 'x', updatedAt: 'x' }],
  };
  assert.deepEqual(await store.importData(parseImport(data)), { groups: 0, bookmarks: 0, skipped: 1 });
});
