// Pure data model: no chrome.* access, so it runs in Node tests too.
//
// Every record is sync-ready: it has a stable UUID, createdAt / updatedAt
// timestamps (ISO strings) and a deletedAt tombstone. A future backend can
// merge records with last-write-wins on updatedAt (see mergeRecords).

export const SCHEMA_VERSION = 1;
export const EXPORT_FORMAT = 'tab-stash';
// Exports made before the rename to Tab Stash use this format name.
const LEGACY_FORMATS = ['tab-shelf'];

// The same 9 colours that Chrome uses for native tab groups, so a saved group
// can be reopened as a real Chrome tab group with the same colour.
export const COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
export const DEFAULT_COLOR = 'grey';

export const COLOR_HEX = {
  grey: '#5f6368',
  blue: '#1a73e8',
  red: '#d93025',
  yellow: '#f9ab00',
  green: '#188038',
  pink: '#d01884',
  purple: '#a142f4',
  cyan: '#007b83',
  orange: '#fa903e',
};

export const GROUP_PREFIX = 'g:';
export const BOOKMARK_PREFIX = 'b:';

const MAX_TITLE = 500;
const MAX_NOTE = 5000;
const MAX_LABEL = 50;
const MAX_LABELS = 30;

export function newId() {
  return crypto.randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}

export function isColor(value) {
  return COLORS.includes(value);
}

export function normalizeColor(value, fallback = DEFAULT_COLOR) {
  return isColor(value) ? value : fallback;
}

/**
 * Accepts an array or a comma-separated string. Trims labels, removes empty
 * ones, and removes duplicates without regard to case (the first spelling wins).
 */
export function normalizeLabels(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(',');
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const label = String(item ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_LABEL);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= MAX_LABELS) break;
  }
  return out;
}

function cleanText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

export function createGroup({ name, note = '', labels = [], color = DEFAULT_COLOR } = {}, now = nowIso()) {
  const cleanName = cleanText(name, MAX_TITLE);
  if (!cleanName) throw new Error('A group must have a name.');
  return {
    id: newId(),
    kind: 'group',
    name: cleanName,
    note: cleanText(note, MAX_NOTE),
    labels: normalizeLabels(labels),
    color: normalizeColor(color),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

export function createBookmark({ groupId, title, url, note = '', labels = [], color } = {}, now = nowIso()) {
  if (!groupId) throw new Error('A bookmark must belong to a group.');
  const cleanUrl = String(url ?? '').trim();
  if (!cleanUrl) throw new Error('A bookmark must have a URL.');
  return {
    id: newId(),
    kind: 'bookmark',
    groupId,
    title: cleanText(title, MAX_TITLE) || cleanUrl,
    url: cleanUrl,
    note: cleanText(note, MAX_NOTE),
    labels: normalizeLabels(labels),
    color: normalizeColor(color),
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

const EDITABLE = {
  group: ['name', 'note', 'labels', 'color'],
  bookmark: ['groupId', 'title', 'url', 'note', 'labels', 'color'],
};

/**
 * The updatedAt for a change of a record. It is always later than the old
 * updatedAt, also when two changes occur in the same millisecond. Sync and
 * import keep the newer record, so a change must never get an equal time.
 */
export function nextUpdatedAt(previous, now = nowIso()) {
  if (!previous || now > previous) return now;
  const prev = Date.parse(previous);
  return Number.isNaN(prev) ? now : new Date(prev + 1).toISOString();
}

/** Returns a new record with the allowed fields changed and updatedAt set. */
export function applyChanges(record, changes, now = nowIso()) {
  const next = { ...record };
  for (const field of EDITABLE[record.kind] ?? []) {
    if (!(field in changes)) continue;
    const value = changes[field];
    if (field === 'labels') next.labels = normalizeLabels(value);
    else if (field === 'color') next.color = normalizeColor(value, record.color);
    else if (field === 'note') next.note = cleanText(value, MAX_NOTE);
    else next[field] = cleanText(value, field === 'url' ? 10_000 : MAX_TITLE);
  }
  if (record.kind === 'group' && !next.name) throw new Error('A group must have a name.');
  if (record.kind === 'bookmark') {
    if (!next.url) throw new Error('A bookmark must have a URL.');
    if (!next.title) next.title = next.url;
  }
  next.updatedAt = nextUpdatedAt(record.updatedAt, now);
  return next;
}

export function markDeleted(record, now = nowIso()) {
  return { ...record, deletedAt: now, updatedAt: nextUpdatedAt(record.updatedAt, now) };
}

export function storageKey(record) {
  return (record.kind === 'group' ? GROUP_PREFIX : BOOKMARK_PREFIX) + record.id;
}

/** URLs that are not useful to save (blank pages and new-tab pages). */
export function isSaveableUrl(url) {
  if (!url) return false;
  return !/^(about:blank|chrome:\/\/newtab\/?|chrome-search:|edge:\/\/newtab)/i.test(url);
}

/**
 * URLs that an extension cannot reopen with tabs.create, or can reopen only with
 * limits. The UI shows a warning for them; it does not refuse to save them.
 */
export function isRestrictedUrl(url) {
  return /^(chrome|chrome-extension|edge|about|devtools|view-source|file|javascript|data):/i.test(url ?? '');
}

/**
 * Filters live bookmarks. All conditions must match:
 *  - text: every word must appear in title, url, note, labels, or the group name
 *  - labels: the bookmark (or its group) must have ALL the given labels
 *  - colors: the bookmark colour must be one of the given colours (empty = any)
 *  - groupId: the bookmark must be in this group (empty = any)
 */
export function filterBookmarks(bookmarks, groupsById, { text = '', labels = [], colors = [], groupId = '' } = {}) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const wantLabels = labels.map((l) => l.toLowerCase());
  return bookmarks.filter((b) => {
    if (b.deletedAt) return false;
    if (groupId && b.groupId !== groupId) return false;
    if (colors.length && !colors.includes(b.color)) return false;
    const group = groupsById.get(b.groupId);
    const allLabels = [...b.labels, ...(group?.labels ?? [])].map((l) => l.toLowerCase());
    if (wantLabels.some((l) => !allLabels.includes(l))) return false;
    if (words.length) {
      const hay = [b.title, b.url, b.note, group?.name ?? '', group?.note ?? '', ...allLabels].join('\n').toLowerCase();
      if (words.some((w) => !hay.includes(w))) return false;
    }
    return true;
  });
}

/** All labels in use on live records, sorted, with their counts. */
export function collectLabels(records) {
  const counts = new Map();
  for (const r of records) {
    if (r.deletedAt) continue;
    for (const label of r.labels ?? []) {
      const key = label.toLowerCase();
      const entry = counts.get(key) ?? { label, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
  }
  return [...counts.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Last-write-wins merge by id. Returns only the incoming records that are new
 * or newer than the local copy. The same rule will apply to server sync.
 */
export function mergeRecords(localRecords, incomingRecords) {
  const local = new Map(localRecords.map((r) => [r.id, r]));
  const changed = [];
  for (const r of incomingRecords) {
    const existing = local.get(r.id);
    if (!existing || r.updatedAt > existing.updatedAt) changed.push(r);
  }
  return changed;
}

function validateCommon(r) {
  return (
    r && typeof r === 'object' &&
    typeof r.id === 'string' && r.id.length > 0 &&
    typeof r.createdAt === 'string' && typeof r.updatedAt === 'string'
  );
}

/** Makes an imported record safe: correct types, known colour, clean labels. */
export function sanitizeRecord(r) {
  if (!validateCommon(r)) return null;
  const base = {
    id: r.id,
    kind: r.kind,
    note: cleanText(r.note, MAX_NOTE),
    labels: normalizeLabels(r.labels ?? []),
    color: normalizeColor(r.color),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    deletedAt: typeof r.deletedAt === 'string' ? r.deletedAt : null,
  };
  if (r.kind === 'group') {
    const name = cleanText(r.name, MAX_TITLE);
    return name ? { ...base, name } : null;
  }
  if (r.kind === 'bookmark') {
    const url = String(r.url ?? '').trim();
    if (!url || typeof r.groupId !== 'string') return null;
    return { ...base, groupId: r.groupId, url, title: cleanText(r.title, MAX_TITLE) || url };
  }
  return null;
}

export function buildExport(groups, bookmarks, now = nowIso()) {
  return { format: EXPORT_FORMAT, version: SCHEMA_VERSION, exportedAt: now, groups, bookmarks };
}

/** Parses an export file. Throws on a wrong format; drops invalid records. */
export function parseImport(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (!data || (data.format !== EXPORT_FORMAT && !LEGACY_FORMATS.includes(data.format))) throw new Error('This file is not a Tab Stash export.');
  if (data.version > SCHEMA_VERSION) throw new Error(`Export version ${data.version} is newer than this extension supports.`);
  const groups = (data.groups ?? []).map((g) => sanitizeRecord({ ...g, kind: 'group' })).filter(Boolean);
  // Bookmarks may refer to groups that exist only locally; the store checks that.
  const bookmarks = (data.bookmarks ?? []).map((b) => sanitizeRecord({ ...b, kind: 'bookmark' })).filter(Boolean);
  return { groups, bookmarks };
}
