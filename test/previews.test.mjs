import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreviews, memoryBackend, previewId, sanitizePreview, isValidImage } from '../extension/lib/previews.js';
import { getDeviceId, DEVICE_KEY } from '../extension/lib/device.js';
import { fakeStorageArea } from './fakes.mjs';

const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

function clock(start = Date.parse('2026-11-02T10:00:00.000Z')) {
  let t = start;
  return () => new Date((t += 1000)).toISOString();
}

test('a preview is kept, replaced and deleted with its bookmark', async () => {
  const backend = memoryBackend();
  const p = createPreviews({ backend, now: clock(), notify: () => {} });
  await p.save('b1', IMG, { scope: 'local' });
  assert.equal((await p.get('b1')).image, IMG);
  assert.deepEqual([...(await p.bookmarkIds())], ['b1']);

  await p.save('b1', IMG.replace('Rg', 'Rh'), { scope: 'account' });
  const got = await p.get('b1');
  assert.equal(got.meta.id, 'preview:account:b1');
  assert.equal((await backend.getAll('meta')).length, 1, 'the local preview is gone, not a tombstone');

  await p.deleteFor(['b1']);
  assert.equal(await p.get('b1'), null);
  const [tomb] = await backend.getAll('meta');
  assert.ok(tomb.deletedAt, 'a synced preview leaves a tombstone');
  assert.deepEqual(await backend.getAll('images'), [], 'the image is removed');
});

test('a change of scope makes a tombstone for the old synced record', async () => {
  const backend = memoryBackend();
  const p = createPreviews({ backend, now: clock(), notify: () => {} });
  await p.save('b1', IMG, { scope: 'account' });
  await p.save('b2', IMG, { scope: 'account' });
  assert.equal(await p.setScope('device', 'dev-12345678'), 2);
  const metas = await backend.getAll('meta');
  assert.deepEqual(metas.filter((m) => !m.deletedAt).map((m) => m.id).sort(),
    ['preview:dev-12345678:b1', 'preview:dev-12345678:b2']);
  assert.deepEqual(metas.filter((m) => m.deletedAt).map((m) => m.id).sort(), ['preview:account:b1', 'preview:account:b2']);
  assert.equal((await p.get('b1')).image, IMG);

  await p.setScope('local');
  assert.deepEqual((await p.syncable()).filter((m) => !m.deletedAt), [], 'local previews are never sent');
  assert.equal((await p.get('b2')).meta.id, 'preview:local:b2');
});

test('tombstones are purged only when allowed', async () => {
  const backend = memoryBackend();
  const p = createPreviews({ backend, now: clock(), notify: () => {} });
  await p.save('b1', IMG, { scope: 'account' });
  await p.deleteFor(['b1']);
  const later = Date.parse('2027-01-01T00:00:00.000Z');
  assert.equal(await p.purge(30, later, () => false), 0);
  assert.equal(await p.purge(30, later), 1);
  assert.deepEqual(await backend.getAll('meta'), []);
});

test('sanitizePreview checks the record and the device', () => {
  const base = {
    id: previewId('account', '', 'b1'), kind: 'preview', bookmarkId: 'b1', scope: 'account', image: IMG,
    createdAt: '2026-11-02T10:00:00.000Z', updatedAt: '2026-11-02T10:00:00.000Z', deletedAt: null, seq: 4,
  };
  assert.deepEqual(Object.keys(sanitizePreview(base, 'dev-a').meta).includes('seq'), false);
  assert.equal(sanitizePreview({ ...base, image: 'javascript:x' }, 'dev-a'), null);
  assert.equal(sanitizePreview({ ...base, scope: 'device', deviceId: 'dev-b' }, 'dev-a'), null, 'another device');
  assert.ok(sanitizePreview({ ...base, scope: 'device', deviceId: 'dev-a' }, 'dev-a'));
  assert.equal(sanitizePreview({ ...base, image: '', deletedAt: '2026-11-02T11:00:00.000Z' }, 'dev-a').image, null);
  assert.equal(isValidImage('data:image/gif;base64,R0lG'), false);
});

test('the device ID is made one time and then kept', async () => {
  const area = fakeStorageArea();
  let n = 0;
  const make = () => `device-${++n}`;
  const [a, b] = await Promise.all([getDeviceId(area, make), getDeviceId(area, make)]);
  assert.equal(a, b);
  assert.equal(await getDeviceId(area, make), a);
  assert.equal((await area.get(DEVICE_KEY))[DEVICE_KEY].id, a);
});
