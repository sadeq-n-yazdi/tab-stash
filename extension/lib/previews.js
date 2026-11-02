// Preview pictures of saved tabs.
//
// A preview has two parts: a small metadata record and the image (a JPEG data
// URL of about 20-40 KB). They are in IndexedDB, not in chrome.storage.local,
// because the pages read all of chrome.storage.local on each change.
//
// The scope of a preview tells where it is kept:
//   "local"   only in this browser; never sent to the server
//   "device"  also on the server, but only this device gets it back
//   "account" also on the server, and all devices of the user get it
//
// The id includes the scope: "preview:<local|account|deviceId>:<bookmarkId>".
// Thus a change of scope is a deletion of the old record and a new record, and
// the other devices get the deletion of the old one.
//
// No chrome.* calls here, so the module runs in Node tests too.

import { nextUpdatedAt } from './model.js';

export const PREVIEW_SCOPES = ['local', 'device', 'account'];
export const PREVIEW_KIND = 'preview';
const IMAGE_PREFIXES = ['data:image/jpeg;base64,', 'data:image/webp;base64,', 'data:image/png;base64,'];
export const MAX_IMAGE_LEN = 400_000;
const CHANNEL = 'tab-stash-previews';

export function previewId(scope, deviceId, bookmarkId) {
  const space = scope === 'device' ? deviceId : scope;
  return `preview:${space}:${bookmarkId}`;
}

export function isValidImage(image) {
  return typeof image === 'string' && image.length <= MAX_IMAGE_LEN && IMAGE_PREFIXES.some((p) => image.startsWith(p));
}

/** Checks a preview record from the server. Returns { meta, image } or null. */
export function sanitizePreview(r, deviceId) {
  if (!r || r.kind !== PREVIEW_KIND || typeof r.id !== 'string' || typeof r.bookmarkId !== 'string') return null;
  if (typeof r.createdAt !== 'string' || typeof r.updatedAt !== 'string') return null;
  if (r.scope !== 'account' && r.scope !== 'device') return null;
  if (r.scope === 'device' && r.deviceId !== deviceId) return null;
  const deletedAt = typeof r.deletedAt === 'string' ? r.deletedAt : null;
  if (!deletedAt && !isValidImage(r.image)) return null;
  const meta = {
    id: r.id, kind: PREVIEW_KIND, bookmarkId: r.bookmarkId, scope: r.scope,
    ...(r.scope === 'device' ? { deviceId: r.deviceId } : {}),
    createdAt: r.createdAt, updatedAt: r.updatedAt, deletedAt,
  };
  return { meta, image: deletedAt ? null : r.image };
}

/** A backend in memory, for tests. */
export function memoryBackend() {
  const stores = { meta: new Map(), images: new Map() };
  return {
    async getAll(name) { return [...stores[name].values()]; },
    async getMany(name, keys) { return keys.map((k) => stores[name].get(k)); },
    async put(name, entries) { for (const [k, v] of entries) stores[name].set(k, v); },
    async delete(name, keys) { for (const k of keys) stores[name].delete(k); },
  };
}

/** A backend on IndexedDB (extension pages and the service worker). */
export function indexedDbBackend(indexedDB = globalThis.indexedDB, dbName = 'tab-stash') {
  let opened;
  function open() {
    opened ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('meta');
        req.result.createObjectStore('images');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return opened;
  }
  async function run(name, mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, mode);
      const os = tx.objectStore(name);
      const result = work(os);
      tx.oncomplete = () => resolve(result.value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  return {
    getAll: (name) => run(name, 'readonly', (os) => {
      const out = {};
      const req = os.getAll();
      req.onsuccess = () => { out.value = req.result; };
      return out;
    }),
    getMany: (name, keys) => run(name, 'readonly', (os) => {
      const out = { value: [] };
      keys.forEach((k, i) => {
        const req = os.get(k);
        req.onsuccess = () => { out.value[i] = req.result; };
      });
      return out;
    }),
    put: (name, entries) => run(name, 'readwrite', (os) => {
      for (const [k, v] of entries) os.put(v, k);
      return {};
    }),
    delete: (name, keys) => run(name, 'readwrite', (os) => {
      for (const k of keys) os.delete(k);
      return {};
    }),
  };
}

/**
 * @param {object} deps
 * @param {object} deps.backend  memoryBackend() or indexedDbBackend()
 * @param {Function} [deps.now]  returns the time as an ISO string
 * @param {Function} [deps.notify] called after each change (pages refresh)
 */
export function createPreviews({ backend, now = () => new Date().toISOString(), notify } = {}) {
  const channel = !notify && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;
  const changed = () => (notify ? notify() : channel?.postMessage('changed'));

  async function allMeta() {
    return (await backend.getAll('meta')) ?? [];
  }

  async function liveFor(bookmarkId) {
    return (await allMeta()).filter((m) => m.bookmarkId === bookmarkId && !m.deletedAt);
  }

  /** Deletes previews: a local one at once, a synced one as a tombstone. */
  async function retire(metas, at = now()) {
    const local = metas.filter((m) => m.scope === 'local').map((m) => m.id);
    const tombstones = metas.filter((m) => m.scope !== 'local')
      .map((m) => ({ ...m, deletedAt: at, updatedAt: nextUpdatedAt(m.updatedAt, at) }));
    if (local.length) await backend.delete('meta', local);
    if (tombstones.length) await backend.put('meta', tombstones.map((m) => [m.id, m]));
    await backend.delete('images', metas.map((m) => m.id));
  }

  return {
    /** Keeps a new preview for a bookmark. It replaces the old previews of the bookmark. */
    async save(bookmarkId, image, { scope = 'local', deviceId = '' } = {}) {
      if (!isValidImage(image)) throw new Error('The preview is not a valid image.');
      if (!PREVIEW_SCOPES.includes(scope)) throw new Error(`Unknown preview scope: ${scope}`);
      const at = now();
      const id = previewId(scope, deviceId, bookmarkId);
      const old = await liveFor(bookmarkId);
      await retire(old.filter((m) => m.id !== id), at);
      const previous = old.find((m) => m.id === id);
      const meta = {
        id, kind: PREVIEW_KIND, bookmarkId, scope,
        ...(scope === 'device' ? { deviceId } : {}),
        createdAt: previous?.createdAt ?? at,
        updatedAt: previous ? nextUpdatedAt(previous.updatedAt, at) : at,
        deletedAt: null,
      };
      await backend.put('images', [[id, image]]);
      await backend.put('meta', [[id, meta]]);
      changed();
      return meta;
    },

    /** The live preview of a bookmark: { meta, image }, or null. */
    async get(bookmarkId) {
      const [meta] = await liveFor(bookmarkId);
      if (!meta) return null;
      const [image] = await backend.getMany('images', [meta.id]);
      return image ? { meta, image } : null;
    },

    /** The ids of the bookmarks that have a live preview. */
    async bookmarkIds() {
      return new Set((await allMeta()).filter((m) => !m.deletedAt).map((m) => m.bookmarkId));
    },

    /** Deletes the previews of deleted bookmarks. */
    async deleteFor(bookmarkIds) {
      const ids = new Set(bookmarkIds);
      const doomed = (await allMeta()).filter((m) => ids.has(m.bookmarkId) && !m.deletedAt);
      if (!doomed.length) return 0;
      await retire(doomed);
      changed();
      return doomed.length;
    },

    /**
     * Moves all live previews to a new scope. The old synced records become
     * tombstones, so the server and the other devices delete them.
     */
    async setScope(scope, deviceId = '') {
      if (!PREVIEW_SCOPES.includes(scope)) throw new Error(`Unknown preview scope: ${scope}`);
      const at = now();
      const live = (await allMeta()).filter((m) => !m.deletedAt);
      let moved = 0;
      for (const meta of live) {
        const id = previewId(scope, deviceId, meta.bookmarkId);
        if (id === meta.id) continue;
        const [image] = await backend.getMany('images', [meta.id]);
        await retire([meta], at);
        if (!image) continue;
        await backend.put('images', [[id, image]]);
        await backend.put('meta', [[id, {
          id, kind: PREVIEW_KIND, bookmarkId: meta.bookmarkId, scope,
          ...(scope === 'device' ? { deviceId } : {}),
          createdAt: meta.createdAt, updatedAt: at, deletedAt: null,
        }]]);
        moved += 1;
      }
      if (moved || live.length) changed();
      return moved;
    },

    // ---------- for the sync ----------

    /** The metadata of all previews that can go to the server. */
    async syncable() {
      return (await allMeta()).filter((m) => m.scope !== 'local');
    },

    /** Server records for these metadata records (with the images). */
    async toServer(metas) {
      const images = await backend.getMany('images', metas.map((m) => m.id));
      return metas.map((m, i) => ({ ...m, image: m.deletedAt ? '' : images[i] ?? '' }))
        .filter((r) => r.deletedAt || r.image);
    },

    /** The current metadata of these ids, as a Map. */
    async getMetas(ids) {
      const got = await backend.getMany('meta', ids);
      return new Map(got.filter(Boolean).map((m) => [m.id, m]));
    },

    /** Writes records from the server (see sanitizePreview). */
    async putFromServer(items) {
      if (!items.length) return;
      const live = items.filter((x) => x.image);
      if (live.length) await backend.put('images', live.map((x) => [x.meta.id, x.image]));
      const dead = items.filter((x) => !x.image).map((x) => x.meta.id);
      if (dead.length) await backend.delete('images', dead);
      await backend.put('meta', items.map((x) => [x.meta.id, x.meta]));
      changed();
    },

    /** Removes old tombstones. `canRemove(meta)` can keep one until the server has it. */
    async purge(days = 30, at = Date.now(), canRemove = () => true) {
      const cutoff = new Date(at - days * 86_400_000).toISOString();
      const ids = (await allMeta()).filter((m) => m.deletedAt && m.deletedAt < cutoff && canRemove(m)).map((m) => m.id);
      if (ids.length) await backend.delete('meta', ids);
      return ids.length;
    },
  };
}

/** Calls `fn` when another page or the service worker changes the previews. */
export function onPreviewsChanged(fn) {
  if (typeof BroadcastChannel === 'undefined') return;
  new BroadcastChannel(CHANNEL).addEventListener('message', () => fn());
}
