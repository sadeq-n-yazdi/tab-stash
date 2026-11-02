import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeLabels, createGroup, createBookmark, applyChanges, markDeleted, filterBookmarks,
  collectLabels, mergeRecords, parseImport, buildExport, isSaveableUrl, isRestrictedUrl, normalizeColor,
} from '../extension/lib/model.js';

test('normalizeLabels trims, removes empties and case-insensitive duplicates', () => {
  assert.deepEqual(normalizeLabels(' Rust , rust, ,deep   dive,AI'), ['Rust', 'deep dive', 'AI']);
  assert.deepEqual(normalizeLabels(['a', 'A', null, 'b']), ['a', 'b']);
  assert.deepEqual(normalizeLabels(undefined), []);
});

test('normalizeColor accepts only Chrome tab group colours', () => {
  assert.equal(normalizeColor('purple'), 'purple');
  assert.equal(normalizeColor('magenta'), 'grey');
  assert.equal(normalizeColor(undefined, 'blue'), 'blue');
});

test('createGroup and createBookmark build sync-ready records', () => {
  const g = createGroup({ name: '  When free ', labels: 'tasks', color: 'green' }, '2026-01-01T00:00:00.000Z');
  assert.equal(g.name, 'When free');
  assert.equal(g.kind, 'group');
  assert.equal(g.deletedAt, null);
  assert.equal(g.updatedAt, '2026-01-01T00:00:00.000Z');
  assert.match(g.id, /^[0-9a-f-]{36}$/);
  assert.throws(() => createGroup({ name: '  ' }));

  const b = createBookmark({ groupId: g.id, url: 'https://x.dev/a', title: '' });
  assert.equal(b.title, 'https://x.dev/a', 'falls back to the URL as title');
  assert.equal(b.color, 'grey');
  assert.throws(() => createBookmark({ groupId: g.id, url: '' }));
  assert.throws(() => createBookmark({ url: 'https://x.dev' }));
});

test('applyChanges edits only allowed fields and bumps updatedAt', () => {
  const b = createBookmark({ groupId: 'g1', url: 'https://a.b', title: 'A' }, '2026-01-01T00:00:00.000Z');
  const next = applyChanges(b, { title: 'B', labels: 'x, y', color: 'nope', id: 'hack', createdAt: 'x' }, '2026-02-01T00:00:00.000Z');
  assert.equal(next.title, 'B');
  assert.deepEqual(next.labels, ['x', 'y']);
  assert.equal(next.color, b.color, 'an invalid colour keeps the old one');
  assert.equal(next.id, b.id);
  assert.equal(next.createdAt, b.createdAt);
  assert.equal(next.updatedAt, '2026-02-01T00:00:00.000Z');
  assert.throws(() => applyChanges(b, { url: '' }));
});

test('filterBookmarks combines text, labels (incl. group labels), colours and group', () => {
  const g1 = createGroup({ name: 'Leisure reading', labels: ['learn'] });
  const g2 = createGroup({ name: 'Blocked tasks' });
  const groups = new Map([[g1.id, g1], [g2.id, g2]]);
  const a = createBookmark({ groupId: g1.id, url: 'https://rust-lang.org', title: 'Rust book', labels: ['rust'], color: 'orange' });
  const b = createBookmark({ groupId: g2.id, url: 'https://jira/T-1', title: 'Ticket', note: 'when API is ready', color: 'red' });
  const c = markDeleted(createBookmark({ groupId: g1.id, url: 'https://gone', title: 'Rust gone' }));
  const all = [a, b, c];

  assert.deepEqual(filterBookmarks(all, groups, {}).map((x) => x.id), [a.id, b.id], 'deleted are hidden');
  assert.deepEqual(filterBookmarks(all, groups, { text: 'rust book' }).map((x) => x.id), [a.id]);
  assert.deepEqual(filterBookmarks(all, groups, { text: 'api ready' }).map((x) => x.id), [b.id], 'searches notes');
  assert.deepEqual(filterBookmarks(all, groups, { text: 'leisure' }).map((x) => x.id), [a.id], 'searches group name');
  assert.deepEqual(filterBookmarks(all, groups, { labels: ['LEARN', 'rust'] }).map((x) => x.id), [a.id], 'group labels count');
  assert.deepEqual(filterBookmarks(all, groups, { colors: ['red'] }).map((x) => x.id), [b.id]);
  assert.deepEqual(filterBookmarks(all, groups, { groupId: g2.id }).map((x) => x.id), [b.id]);
});

test('collectLabels counts labels over live records', () => {
  const g = createGroup({ name: 'G', labels: ['Learn'] });
  const b1 = createBookmark({ groupId: g.id, url: 'u1', labels: ['learn', 'rust'] });
  const b2 = markDeleted(createBookmark({ groupId: g.id, url: 'u2', labels: ['old'] }));
  assert.deepEqual(collectLabels([g, b1, b2]), [{ label: 'Learn', count: 2 }, { label: 'rust', count: 1 }]);
});

test('mergeRecords keeps only new or newer incoming records', () => {
  const local = [{ id: '1', updatedAt: '2026-01-02' }, { id: '2', updatedAt: '2026-01-02' }];
  const incoming = [{ id: '1', updatedAt: '2026-01-01' }, { id: '2', updatedAt: '2026-01-03' }, { id: '3', updatedAt: '2026-01-01' }];
  assert.deepEqual(mergeRecords(local, incoming).map((r) => r.id), ['2', '3']);
});

test('parseImport validates format and sanitises records', () => {
  const g = createGroup({ name: 'G', color: 'blue' });
  const b = createBookmark({ groupId: g.id, url: 'https://ok' });
  const data = buildExport([g, { ...g, id: 'bad', name: '' }], [b, { ...b, id: 'x', url: '' }, { ...b, id: 'y', color: 'evil' }]);
  const parsed = parseImport(JSON.stringify(data));
  assert.deepEqual(parsed.groups.map((x) => x.id), [g.id]);
  assert.deepEqual(parsed.bookmarks.map((x) => x.id), [b.id, 'y']);
  assert.equal(parsed.bookmarks[1].color, 'grey');
  assert.throws(() => parseImport('{"format":"other"}'), /not a Tab Stash export/);
  assert.throws(() => parseImport({ format: 'tab-stash', version: 99 }), /newer/);
  assert.deepEqual(parseImport({ ...data, format: 'tab-shelf' }).groups.map((x) => x.id), [g.id], 'old format name still imports');
});

test('URL helpers', () => {
  assert.equal(isSaveableUrl('https://a.b'), true);
  assert.equal(isSaveableUrl('chrome://newtab/'), false);
  assert.equal(isSaveableUrl('about:blank'), false);
  assert.equal(isSaveableUrl(''), false);
  assert.equal(isRestrictedUrl('chrome://settings'), true);
  assert.equal(isRestrictedUrl('file:///tmp/x'), true);
  assert.equal(isRestrictedUrl('https://a.b'), false);
});
