// Sync with a tab-stash-server (API: docs/backend-api.md).
//
// No chrome.* calls here, so the module runs in Node tests too. The service
// worker is the only writer of the sync state, and it runs one sync at a time.
//
// Change tracking: `known` maps a record id to the updatedAt that the server
// has confirmed. A local record is "dirty" (must be sent) when its updatedAt
// differs from known[id]. Records that the sync itself writes are therefore
// never sent back, and an edit made during a sync stays dirty.

import { sanitizeRecord } from './model.js';

export const SYNC_KEY = 'sync';
export const BATCH = 500;

export const DEFAULT_SYNC = {
  serverUrl: '',
  username: '',
  token: '',
  expiresAt: '',
  cursor: 0,
  known: {},
  lastSyncAt: '',
  lastError: '',
  lastResult: null,
};

export class SyncError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'SyncError';
    this.status = status;
  }
}

/**
 * Checks a server address and returns it without a trailing slash, for example
 * "https://tabs.example.com". Only HTTPS is accepted, except for a server on
 * this computer (localhost or 127.0.0.1).
 */
export function normalizeServerUrl(input) {
  let url;
  try {
    url = new URL(String(input ?? '').trim());
  } catch {
    throw new SyncError('Type the full server address, for example https://tabs.example.com.');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new SyncError('The server address must start with https://.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new SyncError('The server address must not have a user name, a query or a fragment.');
  }
  return (url.origin + url.pathname).replace(/\/+$/, '');
}

/** The host permission pattern for a server address, for example "https://tabs.example.com/*". */
export function originPattern(serverUrl) {
  return `${new URL(serverUrl).origin}/*`;
}

export function isDirty(record, known) {
  return known[record.id] !== record.updatedAt;
}

function messageFor(status, serverText) {
  if (status === 401) return 'The login is not valid any more. Log in again.';
  if (status === 403) return 'This account cannot sync. Use a user account, not an admin account.';
  if (status === 429) return 'Too many requests. Wait one minute, then try again.';
  if (status === 503) return 'The server is busy. Try again later.';
  return `The server answered ${status}${serverText ? `: ${serverText}` : ''}.`;
}

/**
 * @param {object} deps
 * @param {object} deps.area   chrome.storage.local, or a fake in tests
 * @param {object} deps.store  the store from store.js, on the same area
 * @param {Function} deps.fetch
 * @param {Function} [deps.now] returns the time as an ISO string
 */
export function createSync({ area, store, fetch, now = () => new Date().toISOString() }) {
  async function getState() {
    const got = await area.get(SYNC_KEY);
    return { ...DEFAULT_SYNC, ...(got[SYNC_KEY] ?? {}) };
  }

  async function setState(changes) {
    const next = { ...(await getState()), ...changes };
    await area.set({ [SYNC_KEY]: next });
    return next;
  }

  async function request(serverUrl, path, { method = 'GET', token = '', body } = {}) {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetch(serverUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (error) {
      throw new SyncError(`Cannot connect to the server (${error?.message ?? error}).`);
    }
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) throw new SyncError(messageFor(response.status, data?.error), response.status);
    return data;
  }

  /** Sends the dirty records. Returns { sent, rejected: [{ id, error }] }. */
  async function push(state) {
    const { groups, bookmarks } = await store.load({ includeDeleted: true });
    const dirty = [...groups, ...bookmarks].filter((r) => isDirty(r, state.known));
    // Send groups first, so the server has a group before its bookmarks.
    dirty.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'group' ? -1 : 1));
    const rejected = [];
    for (let i = 0; i < dirty.length; i += BATCH) {
      const chunk = dirty.slice(i, i + BATCH);
      const result = await request(state.serverUrl, '/api/v1/sync', {
        method: 'POST', token: state.token, body: { records: chunk },
      });
      const bad = new Set((result?.rejected ?? []).map((r) => r.id));
      rejected.push(...(result?.rejected ?? []));
      const known = { ...(await getState()).known };
      for (const r of chunk) if (!bad.has(r.id)) known[r.id] = r.updatedAt;
      await setState({ known });
    }
    return { sent: dirty.length - rejected.length, rejected };
  }

  /** Gets the changes from the server and writes the newer ones. Returns the count. */
  async function pull(state) {
    let cursor = state.cursor;
    let received = 0;
    for (;;) {
      const page = await request(state.serverUrl, `/api/v1/sync?since=${encodeURIComponent(cursor)}`, { token: state.token });
      const incoming = (page?.records ?? []).map(sanitizeRecord).filter(Boolean);
      // Mark the server versions as known first. If the browser stops before
      // the records are written, the cursor is not saved and the page comes again.
      const known = { ...(await getState()).known };
      for (const r of incoming) known[r.id] = r.updatedAt;
      await setState({ known });
      // Compare with a fresh read, so that an edit made during the sync wins.
      const current = await store.getRecords(incoming);
      const newer = incoming.filter((r) => {
        const local = current.get(r.id);
        return !local || r.updatedAt > local.updatedAt;
      });
      await store.putRecords(newer);
      received += newer.length;
      if (typeof page?.cursor === 'number') cursor = page.cursor;
      await setState({ cursor });
      if (!page?.more) break;
    }
    return received;
  }

  async function runSync() {
    const state = await getState();
    if (!state.token) return { skipped: true };
    if (state.expiresAt && state.expiresAt <= now()) {
      await setState({ token: '', expiresAt: '', lastError: messageFor(401) });
      return { skipped: true, error: messageFor(401) };
    }
    try {
      const { sent, rejected } = await push(state);
      const received = await pull(await getState());
      const lastError = rejected.length
        ? `The server did not accept ${rejected.length} record(s): ${rejected[0].error}.`
        : '';
      const lastResult = { sent, received, rejected: rejected.length };
      await setState({ lastSyncAt: now(), lastError, lastResult });
      return lastResult;
    } catch (error) {
      const changes = { lastError: error.message ?? String(error) };
      if (error.status === 401 || error.status === 403) Object.assign(changes, { token: '', expiresAt: '' });
      await setState(changes);
      throw error;
    }
  }

  // One sync at a time: a new request waits for the one that runs.
  let queue = Promise.resolve();
  function serialize(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  }

  return {
    getState,

    /** Logs in, keeps the token (not the password) and does the first sync. */
    login: ({ serverUrl, username, password, client = 'Tab Stash' }) => serialize(async () => {
      const url = normalizeServerUrl(serverUrl);
      const name = String(username ?? '').trim();
      if (!name || !password) throw new SyncError('Type the user name and the password.');
      const old = await getState();
      const result = await request(url, '/api/v1/auth/login', {
        method: 'POST', body: { username: name, password, client },
      }).catch((error) => {
        if (error.status === 401) throw new SyncError('The user name or the password is not correct.', 401);
        throw error;
      });
      if (!result?.token) throw new SyncError('The server did not send a token.');
      const sameAccount = old.serverUrl === url && old.username === name;
      await setState({
        serverUrl: url,
        username: name,
        token: result.token,
        expiresAt: result.expiresAt ?? '',
        lastError: '',
        // A different server or account starts again from the first record.
        ...(sameAccount ? {} : { cursor: 0, known: {}, lastSyncAt: '', lastResult: null }),
      });
    }).then(() => serialize(runSync)),

    /** Logs out on the server (if it answers) and removes the token. */
    logout: () => serialize(async () => {
      const state = await getState();
      if (state.token) {
        await request(state.serverUrl, '/api/v1/auth/logout', { method: 'POST', token: state.token }).catch(() => {});
      }
      await setState({ token: '', expiresAt: '', lastError: '' });
    }),

    /** Sends the local changes and gets the server changes. */
    syncNow: () => serialize(runSync),

    /**
     * Removes old deleted records. When sync was set up, it removes a deleted
     * record only after the server has its last version.
     */
    purge: (days, at) => serialize(async () => {
      const state = await getState();
      if (!state.serverUrl) return store.purgeDeleted(days, at);
      const removed = [];
      const count = await store.purgeDeleted(days, at, (r) => {
        if (state.known[r.id] !== r.updatedAt) return false;
        removed.push(r.id);
        return true;
      });
      if (removed.length) {
        const known = { ...(await getState()).known };
        for (const id of removed) delete known[id];
        await setState({ known });
      }
      return count;
    }),

    /** True when the record must be sent to the server. */
    async needsSync(record) {
      const state = await getState();
      return Boolean(state.token) && isDirty(record, state.known);
    },
  };
}
