// Sync test against the real Go server (server/). It builds the server,
// starts it on a loopback port with a temporary database, and syncs two
// simulated browsers through it. It is skipped when Go is not installed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeStorageArea } from './fakes.mjs';
import { createStore } from '../extension/lib/store.js';
import { createSync, MAX_PUSH_BYTES } from '../extension/lib/sync.js';
import { createPreviews, memoryBackend } from '../extension/lib/previews.js';
import { hasGo, startGoServer, TEST_PASSWORD as PASSWORD } from './go-server.mjs';

async function startServer(t) {
  const { url, stop } = await startGoServer({ users: ['alice'], admins: ['root'] });
  t.after(stop);
  return url;
}

let deviceCount = 0;
function device(fetchImpl = fetch) {
  const area = fakeStorageArea();
  const store = createStore(area);
  const previews = createPreviews({ backend: memoryBackend(), notify: () => {} });
  const id = `device-${String(++deviceCount).padStart(4, '0')}`;
  const sync = createSync({ area, store, fetch: fetchImpl, previews, deviceId: async () => id });
  return { area, store, previews, id, sync };
}

const IMG = `data:image/jpeg;base64,${'A'.repeat(1000)}`;

test('sync through the real server', { skip: !hasGo && 'Go is not installed' }, async (t) => {
  const url = await startServer(t);
  const login = (d, username = 'alice') => d.sync.login({ serverUrl: url, username, password: PASSWORD, client: 'test' });

  await t.test('two browsers converge', async () => {
    const a = device();
    const b = device();
    const work = await a.store.addGroup({ name: 'Work', color: 'blue', labels: ['job'] });
    await a.store.addBookmarks(work.id, [
      { title: 'One', url: 'https://one.example/', note: 'first' },
      { title: 'Two', url: 'https://two.example/' },
    ]);
    await login(a);
    await login(b);
    const onB = await b.store.load();
    assert.deepEqual(onB.groups.map((g) => [g.name, g.color, g.labels]), [['Work', 'blue', ['job']]]);
    assert.deepEqual(onB.bookmarks.map((x) => x.url).sort(), ['https://one.example/', 'https://two.example/']);
    assert.equal(onB.bookmarks.find((x) => x.title === 'One').note, 'first');

    // An edit and a deletion on B reach A.
    await b.store.updateGroup(work.id, { name: 'Work stuff' });
    await b.store.deleteBookmarks([onB.bookmarks.find((x) => x.title === 'Two').id]);
    assert.deepEqual(await b.sync.syncNow(), { sent: 2, received: 0, rejected: 0 });
    assert.deepEqual(await a.sync.syncNow(), { sent: 0, received: 2, rejected: 0 });
    const onA = await a.store.load();
    assert.deepEqual(onA.groups.map((g) => g.name), ['Work stuff']);
    assert.deepEqual(onA.bookmarks.map((x) => x.title), ['One']);

    // Nothing is sent again.
    assert.deepEqual(await a.sync.syncNow(), { sent: 0, received: 0, rejected: 0 });
    assert.deepEqual(await b.sync.syncNow(), { sent: 0, received: 0, rejected: 0 });
  });

  await t.test('an edit made during a sync is kept and sent next time', async () => {
    const b = device();
    await login(b);
    const [group] = (await b.store.load()).groups;
    await b.store.updateGroup(group.id, { note: 'from B' });
    await b.sync.syncNow();

    // Device C edits the same group while its GET request runs.
    let editDuringGet = async () => {};
    const c = device(async (input, init) => {
      if (String(input).includes('/api/v1/sync?')) await editDuringGet();
      return fetch(input, init);
    });
    await login(c);
    editDuringGet = async () => {
      editDuringGet = async () => {};
      await c.store.updateGroup(group.id, { note: 'from C, during the sync' });
    };
    await b.store.updateGroup(group.id, { note: 'from B again' });
    await b.sync.syncNow();
    await c.sync.syncNow();
    // C's edit is newer than B's, so it stays on C and goes to the server.
    assert.equal((await c.store.getGroup(group.id)).note, 'from C, during the sync');
    assert.equal(await c.sync.needsSync(await c.store.getGroup(group.id)), true);
    await c.sync.syncNow();
    await b.sync.syncNow();
    assert.equal((await b.store.getGroup(group.id)).note, 'from C, during the sync');
  });

  await t.test('a deleted record is kept until the server has it', async () => {
    const a = device();
    await login(a);
    const [group] = (await a.store.load()).groups;
    const [bm] = (await a.store.addBookmarks(group.id, [{ url: 'https://purge.example/' }])).added;
    await a.sync.syncNow();
    await a.store.deleteBookmarks([bm.id]);
    const later = Date.now() + 1000;
    await a.sync.purge(0, later);
    assert.ok(await a.store.getBookmark(bm.id), 'kept: the server does not have the deletion');
    await a.sync.syncNow();
    await a.sync.purge(0, later);
    assert.equal(await a.store.getBookmark(bm.id), null, 'removed after the sync');
  });

  await t.test('previews go to the right devices', async () => {
    const a = device();
    const b = device();
    await login(a);
    await login(b);
    const [group] = (await a.store.load()).groups;
    const { added } = await a.store.addBookmarks(group.id, [
      { url: 'https://shared.example/' }, { url: 'https://mine.example/' }, { url: 'https://local.example/' },
    ]);
    const [shared, mine, local] = added;
    await a.previews.save(shared.id, IMG, { scope: 'account' });
    await a.previews.save(mine.id, IMG, { scope: 'device', deviceId: a.id });
    await a.previews.save(local.id, IMG, { scope: 'local' });
    const sent = await a.sync.syncNow();
    assert.equal(sent.rejected, 0);
    await b.sync.syncNow();
    assert.equal((await b.previews.get(shared.id))?.image, IMG, 'B gets the shared preview');
    assert.equal(await b.previews.get(mine.id), null, 'B does not get the preview of device A');
    assert.equal(await b.previews.get(local.id), null, 'a local preview is never sent');

    // A new install of device A gets its own device preview back.
    const a2 = device();
    a2.id = a.id;
    const again = createSync({ area: a2.area, store: a2.store, fetch, previews: a2.previews, deviceId: async () => a.id });
    await again.login({ serverUrl: url, username: 'alice', password: PASSWORD, client: 'test' });
    assert.equal((await a2.previews.get(mine.id))?.image, IMG);

    // A deleted bookmark deletes its preview on the other device.
    await a.store.deleteBookmarks([shared.id]);
    await a.previews.deleteFor([shared.id]);
    await a.sync.syncNow();
    await b.sync.syncNow();
    assert.equal(await b.previews.get(shared.id), null);
  });

  await t.test('a change to local deletes the preview on the server', async () => {
    const a = device();
    const b = device();
    await login(a);
    await login(b);
    const [group] = (await a.store.load()).groups;
    const { added: [bm] } = await a.store.addBookmarks(group.id, [{ url: 'https://scope.example/' }]);
    await a.previews.save(bm.id, IMG, { scope: 'account' });
    await a.sync.syncNow();
    await b.sync.syncNow();
    assert.ok(await b.previews.get(bm.id));
    await a.previews.setScope('local');
    await a.sync.syncNow();
    await b.sync.syncNow();
    assert.equal(await b.previews.get(bm.id), null, 'B deletes it');
    assert.ok(await a.previews.get(bm.id), 'A keeps it on this computer');
  });

  await t.test('a large push is split by size', async () => {
    const sizes = [];
    const a = device(async (input, init) => {
      if (init?.method === 'POST' && String(input).endsWith('/api/v1/sync')) sizes.push(init.body.length);
      return fetch(input, init);
    });
    await login(a);
    const [group] = (await a.store.load()).groups;
    const { added } = await a.store.addBookmarks(group.id,
      Array.from({ length: 30 }, (_, i) => ({ url: `https://big${i}.example/` })));
    const big = `data:image/jpeg;base64,${'B'.repeat(390_000)}`;
    for (const bm of added) await a.previews.save(bm.id, big, { scope: 'account' });
    sizes.length = 0;
    const result = await a.sync.syncNow();
    assert.equal(result.rejected, 0);
    assert.ok(sizes.length >= 3, `requests: ${sizes}`);
    for (const size of sizes) assert.ok(size <= MAX_PUSH_BYTES + 500_000, `a request of ${size} bytes`);
  });

  await t.test('an admin account cannot sync', async () => {
    const d = device();
    await assert.rejects(login(d, 'root'), /cannot sync/);
    assert.equal((await d.sync.getState()).token, '');
  });

  await t.test('a wrong password is refused', async () => {
    const d = device();
    await assert.rejects(
      d.sync.login({ serverUrl: url, username: 'alice', password: 'not-the-password' }),
      /not correct/,
    );
  });
});
