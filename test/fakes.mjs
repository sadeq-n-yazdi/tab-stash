// Minimal in-memory fakes of the chrome APIs used by store.js and actions.js.

export function fakeStorageArea() {
  const data = new Map();
  const clone = (v) => structuredClone(v);
  return {
    data,
    async get(keys) {
      if (keys == null) return Object.fromEntries([...data].map(([k, v]) => [k, clone(v)]));
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => data.has(k)).map((k) => [k, clone(data.get(k))]));
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) data.set(k, clone(v));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
}

export function fakeChrome({ tabs = [], failUrls = [] } = {}) {
  let nextTabId = 1000;
  let nextWindowId = 50;
  let nextGroupId = 900;
  const state = { tabs: tabs.map((t) => ({ pinned: false, groupId: -1, ...t })), tabGroups: [], log: [] };

  const matches = (t, q) =>
    (q.windowId == null || t.windowId === q.windowId) &&
    (q.active == null || t.active === q.active) &&
    (q.groupId == null || t.groupId === q.groupId) &&
    (q.lastFocusedWindow == null || t.windowId === state.tabs.find((x) => x.active)?.windowId);

  const chrome = {
    state,
    runtime: { getURL: (p = '') => `chrome-extension://abc/${p}` },
    tabs: {
      async query(q = {}) { return state.tabs.filter((t) => matches(t, q)); },
      async get(id) {
        const t = state.tabs.find((x) => x.id === id);
        if (!t) throw new Error(`No tab ${id}`);
        return t;
      },
      async create({ url = 'chrome://newtab/', windowId, active = false }) {
        if (failUrls.includes(url)) throw new Error(`Cannot open ${url}`);
        const tab = { id: nextTabId++, url, title: url, windowId, active, pinned: false, groupId: -1 };
        state.tabs.push(tab);
        state.log.push(['create', url, windowId]);
        return tab;
      },
      async remove(ids) {
        const set = new Set(Array.isArray(ids) ? ids : [ids]);
        state.log.push(['remove', [...set]]);
        state.tabs = state.tabs.filter((t) => !set.has(t.id));
      },
      async group({ tabIds }) {
        const id = nextGroupId++;
        for (const t of state.tabs) if (tabIds.includes(t.id)) t.groupId = id;
        state.tabGroups.push({ id });
        return id;
      },
    },
    tabGroups: {
      async update(id, props) { Object.assign(state.tabGroups.find((g) => g.id === id), props); },
      async query() { return state.tabGroups; },
    },
    windows: {
      async create() {
        const id = nextWindowId++;
        const tab = { id: nextTabId++, url: 'chrome://newtab/', windowId: id, active: true, groupId: -1 };
        state.tabs.push(tab);
        return { id, tabs: [tab] };
      },
    },
  };
  return chrome;
}
