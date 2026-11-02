// Sync test against the real Go server (server/). It builds the server,
// starts it on a loopback port with a temporary database, and syncs two
// simulated browsers through it. It is skipped when Go is not installed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeStorageArea } from './fakes.mjs';
import { createStore } from '../extension/lib/store.js';
import { createSync } from '../extension/lib/sync.js';
import { hasGo, startGoServer, TEST_PASSWORD as PASSWORD } from './go-server.mjs';

async function startServer(t) {
  const { url, stop } = await startGoServer({ users: ['alice'], admins: ['root'] });
  t.after(stop);
  return url;
}

function device(fetchImpl = fetch) {
  const area = fakeStorageArea();
  const store = createStore(area);
  return { area, store, sync: createSync({ area, store, fetch: fetchImpl }) };
}

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
