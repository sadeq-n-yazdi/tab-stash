import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeStorageArea } from './fakes.mjs';
import { createStore } from '../extension/lib/store.js';
import { createSync, normalizeServerUrl, originPattern, SyncError, BATCH } from '../extension/lib/sync.js';

// A small in-memory copy of the server API (docs/backend-api.md, section 5).
function fakeServer({ rejectIds = [] } = {}) {
  const records = new Map();
  let seq = 0;
  const calls = [];
  let tokenValid = true;
  const json = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  });
  async function fetch(url, init = {}) {
    const { pathname, searchParams } = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, pathname, count: body?.records?.length });
    if (pathname === '/api/v1/auth/login') {
      if (body.password !== 'right-password') return json(401, { error: 'wrong' });
      tokenValid = true;
      return json(200, { token: 'tok', expiresAt: '2099-01-01T00:00:00.000Z' });
    }
    if (init.headers?.Authorization !== 'Bearer tok' || !tokenValid) return json(401, { error: 'login' });
    if (pathname === '/api/v1/auth/logout') return json(204);
    if (pathname === '/api/v1/sync' && method === 'POST') {
      assert.ok(body.records.length <= BATCH, 'a request has too many records');
      let accepted = 0;
      let ignored = 0;
      const rejected = [];
      for (const r of body.records) {
        if (rejectIds.includes(r.id)) { rejected.push({ id: r.id, error: 'color is not valid' }); continue; }
        const old = records.get(r.id);
        if (old && r.updatedAt <= old.updatedAt) { ignored += 1; continue; }
        records.set(r.id, { ...r, seq: ++seq });
        accepted += 1;
      }
      return json(200, { accepted, ignored, rejected });
    }
    if (pathname === '/api/v1/sync') {
      const since = Number(searchParams.get('since'));
      const all = [...records.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq);
      const page = all.slice(0, BATCH);
      return json(200, { records: page, cursor: page.length ? page.at(-1).seq : since, more: all.length > BATCH });
    }
    return json(404, { error: 'not found' });
  }
  return { fetch, records, calls, expireToken: () => { tokenValid = false; } };
}

function device(server) {
  const area = fakeStorageArea();
  const store = createStore(area);
  const sync = createSync({ area, store, fetch: server.fetch });
  return { area, store, sync };
}

const login = (d) => d.sync.login({ serverUrl: 'https://tabs.example.com/', username: 'alice', password: 'right-password' });

test('normalizeServerUrl accepts HTTPS and a local HTTP server only', () => {
  assert.equal(normalizeServerUrl(' https://Tabs.Example.com/ '), 'https://tabs.example.com');
  assert.equal(normalizeServerUrl('https://example.com/stash/'), 'https://example.com/stash');
  assert.equal(normalizeServerUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.equal(normalizeServerUrl('http://localhost:8080/'), 'http://localhost:8080');
  assert.throws(() => normalizeServerUrl('http://tabs.example.com'), SyncError);
  assert.throws(() => normalizeServerUrl('tabs.example.com'), SyncError);
  assert.throws(() => normalizeServerUrl('https://u:p@tabs.example.com'), SyncError);
  assert.throws(() => normalizeServerUrl('ftp://tabs.example.com'), SyncError);
  assert.equal(originPattern('https://example.com/stash'), 'https://example.com/*');
});

test('a wrong password gives a clear error and keeps no token', async () => {
  const d = device(fakeServer());
  await assert.rejects(
    d.sync.login({ serverUrl: 'https://tabs.example.com', username: 'alice', password: 'nope' }),
    /user name or the password is not correct/,
  );
  assert.equal((await d.sync.getState()).token, '');
});

test('two devices converge, and a second sync sends nothing', async () => {
  const server = fakeServer();
  const a = device(server);
  const b = device(server);
  const group = await a.store.addGroup({ name: 'Work', color: 'blue' });
  await a.store.addBookmarks(group.id, [{ title: 'One', url: 'https://one.example/' }]);
  await login(a);
  await login(b);
  const onB = await b.store.load();
  assert.deepEqual(onB.groups.map((g) => g.name), ['Work']);
  assert.deepEqual(onB.bookmarks.map((x) => x.url), ['https://one.example/']);

  const before = server.calls.length;
  const result = await a.sync.syncNow();
  assert.deepEqual(result, { sent: 0, received: 0, rejected: 0 });
  assert.equal(server.calls.slice(before).filter((c) => c.method === 'POST').length, 0, 'nothing to send');

  // A deletion on B reaches A.
  await b.store.deleteBookmarks(onB.bookmarks.map((x) => x.id));
  await b.sync.syncNow();
  await a.sync.syncNow();
  assert.equal((await a.store.load()).bookmarks.length, 0);
});

test('the sync does not send back the records that it wrote', async () => {
  const server = fakeServer();
  const a = device(server);
  const b = device(server);
  await a.store.addGroup({ name: 'Shared', color: 'green' });
  await login(a);
  await login(b);
  const before = server.calls.length;
  assert.deepEqual(await b.sync.syncNow(), { sent: 0, received: 0, rejected: 0 });
  assert.ok(server.calls.slice(before).every((c) => c.method === 'GET'));
});

test('large stashes go in chunks of 500 records', async () => {
  const server = fakeServer();
  const a = device(server);
  const group = await a.store.addGroup({ name: 'Big', color: 'red' });
  const items = Array.from({ length: 1201 }, (_, i) => ({ title: `T${i}`, url: `https://e.example/${i}` }));
  await a.store.addBookmarks(group.id, items);
  await login(a);
  const posts = server.calls.filter((c) => c.method === 'POST' && c.pathname === '/api/v1/sync');
  assert.deepEqual(posts.map((c) => c.count), [500, 500, 202]);
  const b = device(server);
  await login(b);
  assert.equal((await b.store.load()).bookmarks.length, 1201);
});

test('rejected records stay dirty and show an error', async () => {
  const a0 = fakeStorageArea();
  const store = createStore(a0);
  const group = await store.addGroup({ name: 'G' });
  const server = fakeServer({ rejectIds: [group.id] });
  const sync = createSync({ area: a0, store, fetch: server.fetch });
  await sync.login({ serverUrl: 'https://tabs.example.com', username: 'alice', password: 'right-password' });
  const state = await sync.getState();
  assert.match(state.lastError, /did not accept 1 record/);
  assert.equal(state.known[group.id], undefined);
  assert.equal(await sync.needsSync(group), true);
});

test('an expired login removes the token and stops the sync', async () => {
  const server = fakeServer();
  const a = device(server);
  await login(a);
  server.expireToken();
  await assert.rejects(a.sync.syncNow(), /Log in again/);
  const state = await a.sync.getState();
  assert.equal(state.token, '');
  assert.match(state.lastError, /Log in again/);
  assert.deepEqual(await a.sync.syncNow(), { skipped: true });
});

test('a deleted record is purged only after the server has it', async () => {
  const server = fakeServer();
  const a = device(server);
  const group = await a.store.addGroup({ name: 'G' });
  const [bm] = (await a.store.addBookmarks(group.id, [{ url: 'https://x.example/' }])).added;
  await login(a);
  await a.store.deleteBookmarks([bm.id]);
  const later = Date.now() + 1000;
  assert.equal(await a.sync.purge(0, later), 0, 'the server does not have the deletion yet');
  await a.sync.syncNow();
  assert.equal(await a.sync.purge(0, later), 1);
  assert.equal((await a.sync.getState()).known[bm.id], undefined);
});

test('without sync, purge works as before', async () => {
  const a = device(fakeServer());
  const group = await a.store.addGroup({ name: 'G' });
  await a.store.deleteGroup(group.id);
  assert.equal(await a.sync.purge(0, Date.now() + 1000), 1);
});

test('a login to a different account starts again from the first record', async () => {
  const server = fakeServer();
  const a = device(server);
  await a.store.addGroup({ name: 'G' });
  await login(a);
  assert.ok((await a.sync.getState()).cursor > 0);
  await a.sync.login({ serverUrl: 'https://other.example.com', username: 'alice', password: 'right-password' });
  const state = await a.sync.getState();
  assert.equal(state.serverUrl, 'https://other.example.com');
  // All local records were sent again to the new server.
  assert.equal(Object.keys(state.known).length, 1);
});
