// Storage layer. Every record lives under its own key ("g:<id>" or "b:<id>"),
// so two pages that write at the same time never overwrite each other's data.
//
// `area` is chrome.storage.local in the extension and a fake in tests. The
// sync module (sync.js) reads and writes records through this file.

import {
  GROUP_PREFIX, BOOKMARK_PREFIX, createGroup, createBookmark, applyChanges, markDeleted,
  storageKey, mergeRecords, buildExport, normalizeColor,
} from './model.js';

export const SETTINGS_KEY = 'settings';

export const DEFAULT_SETTINGS = {
  lastGroupId: null,
  closeAfterSave: true,
  skipPinned: true,
  restoreAsTabGroup: true,
  removeOnRestore: false,
};

const TOMBSTONE_DAYS = 30;

export function createStore(area) {
  async function readAll() {
    const all = await area.get(null);
    const groups = [];
    const bookmarks = [];
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith(GROUP_PREFIX)) groups.push(value);
      else if (key.startsWith(BOOKMARK_PREFIX)) bookmarks.push(value);
    }
    return { groups, bookmarks, settings: { ...DEFAULT_SETTINGS, ...(all[SETTINGS_KEY] ?? {}) } };
  }

  async function put(...records) {
    if (!records.length) return;
    await area.set(Object.fromEntries(records.map((r) => [storageKey(r), r])));
  }

  async function getRecord(prefix, id) {
    const key = prefix + id;
    const got = await area.get(key);
    return got[key] ?? null;
  }

  const store = {
    /** Live (not deleted) groups and bookmarks, sorted for display. */
    async load({ includeDeleted = false } = {}) {
      const data = await readAll();
      if (!includeDeleted) {
        data.groups = data.groups.filter((g) => !g.deletedAt);
        const live = new Set(data.groups.map((g) => g.id));
        data.bookmarks = data.bookmarks.filter((b) => !b.deletedAt && live.has(b.groupId));
      }
      data.groups.sort((a, b) => a.name.localeCompare(b.name));
      data.bookmarks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return data;
    },

    async getSettings() {
      const got = await area.get(SETTINGS_KEY);
      return { ...DEFAULT_SETTINGS, ...(got[SETTINGS_KEY] ?? {}) };
    },

    async updateSettings(changes) {
      const next = { ...(await store.getSettings()), ...changes };
      await area.set({ [SETTINGS_KEY]: next });
      return next;
    },

    getGroup: (id) => getRecord(GROUP_PREFIX, id),
    getBookmark: (id) => getRecord(BOOKMARK_PREFIX, id),

    async addGroup(fields) {
      const group = createGroup(fields);
      await put(group);
      return group;
    },

    async updateGroup(id, changes) {
      const group = await store.getGroup(id);
      if (!group || group.deletedAt) throw new Error('Group not found.');
      const next = applyChanges(group, changes);
      await put(next);
      return next;
    },

    /** Deletes a group and every bookmark in it (as tombstones). */
    async deleteGroup(id) {
      const { groups, bookmarks } = await readAll();
      const group = groups.find((g) => g.id === id);
      if (!group) return 0;
      const doomed = bookmarks.filter((b) => b.groupId === id && !b.deletedAt).map((b) => markDeleted(b));
      await put(markDeleted(group), ...doomed);
      return doomed.length;
    },

    /**
     * Adds bookmarks to a group. A URL that is already live in the same group
     * is not added twice. Returns { added, duplicates }.
     */
    async addBookmarks(groupId, items) {
      const group = await store.getGroup(groupId);
      if (!group || group.deletedAt) throw new Error('Group not found.');
      const { bookmarks } = await readAll();
      const existing = new Set(bookmarks.filter((b) => b.groupId === groupId && !b.deletedAt).map((b) => b.url));
      const added = [];
      let duplicates = 0;
      // Lists show newest first. Give earlier tabs a slightly later timestamp,
      // so a batch keeps its tab order (first tab on top).
      const base = Date.now();
      items.forEach((item, i) => {
        if (existing.has(item.url)) { duplicates += 1; return; }
        existing.add(item.url);
        const createdAt = new Date(base + items.length - 1 - i).toISOString();
        added.push(createBookmark({ ...item, groupId, color: normalizeColor(item.color, group.color) }, createdAt));
      });
      await put(...added);
      return { added, duplicates };
    },

    async updateBookmark(id, changes) {
      const bookmark = await store.getBookmark(id);
      if (!bookmark || bookmark.deletedAt) throw new Error('Bookmark not found.');
      if (changes.groupId && changes.groupId !== bookmark.groupId) {
        const target = await store.getGroup(changes.groupId);
        if (!target || target.deletedAt) throw new Error('Target group not found.');
      }
      const next = applyChanges(bookmark, changes);
      await put(next);
      return next;
    },

    async deleteBookmarks(ids) {
      const got = await area.get(ids.map((id) => BOOKMARK_PREFIX + id));
      const doomed = Object.values(got).filter((b) => !b.deletedAt).map((b) => markDeleted(b));
      await put(...doomed);
      return doomed.length;
    },

    /** Makes sure at least one group exists; returns the group to save into by default. */
    async ensureDefaultGroup() {
      const { groups, settings } = await store.load();
      const last = groups.find((g) => g.id === settings.lastGroupId);
      if (last) return last;
      const group = groups[0] ?? (await store.addGroup({ name: 'Inbox', color: 'grey' }));
      await store.updateSettings({ lastGroupId: group.id });
      return group;
    },

    async exportData() {
      const { groups, bookmarks } = await store.load();
      return buildExport(groups, bookmarks);
    },

    /**
     * Merges parsed import data (see model.parseImport). Newer records win.
     * Bookmarks whose group is unknown are skipped.
     */
    async importData({ groups, bookmarks }) {
      const local = await readAll();
      const changedGroups = mergeRecords(local.groups, groups);
      const knownGroups = new Set([...local.groups, ...groups].map((g) => g.id));
      const validBookmarks = bookmarks.filter((b) => knownGroups.has(b.groupId));
      const changedBookmarks = mergeRecords(local.bookmarks, validBookmarks);
      await put(...changedGroups, ...changedBookmarks);
      return {
        groups: changedGroups.length,
        bookmarks: changedBookmarks.length,
        skipped: bookmarks.length - validBookmarks.length,
      };
    },

    /** The current local copies of these records (by id), for the sync merge. */
    async getRecords(records) {
      if (!records.length) return new Map();
      const got = await area.get(records.map(storageKey));
      return new Map(Object.values(got).map((r) => [r.id, r]));
    },

    /** Writes records exactly as given (from the sync server). */
    async putRecords(records) {
      await put(...records);
    },

    /**
     * Removes deleted records older than `days`. `canRemove(record)` can keep
     * a record, for example until the sync server has it.
     */
    async purgeDeleted(days = TOMBSTONE_DAYS, now = Date.now(), canRemove = () => true) {
      const { groups, bookmarks } = await readAll();
      const cutoff = new Date(now - days * 86_400_000).toISOString();
      const keys = [...groups, ...bookmarks]
        .filter((r) => r.deletedAt && r.deletedAt < cutoff && canRemove(r))
        .map(storageKey);
      if (keys.length) await area.remove(keys);
      return keys.length;
    },
  };

  return store;
}
