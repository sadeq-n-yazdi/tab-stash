// Tab operations: collect tabs, save them, close them, open saved ones again.
// `chrome` is injected so these functions can be tested with a fake.

import { isSaveableUrl, isColor } from './model.js';

function tabUrl(tab) {
  return tab.pendingUrl || tab.url || '';
}

function isOwnPage(chrome, url) {
  return url.startsWith(chrome.runtime.getURL(''));
}

/**
 * Returns the tabs to save for a scope:
 *  - 'current'  : the active tab of the window
 *  - 'window'   : all tabs of the window (pinned tabs skipped when skipPinned)
 *  - 'tabGroup' : all tabs of one native Chrome tab group
 *  - 'tabIds'   : the given tab ids
 * Blank pages and this extension's own pages are never saved.
 */
export async function collectTabs(chrome, { scope, windowId, tabGroupId, tabIds = [], skipPinned = true }) {
  let tabs;
  if (scope === 'current') tabs = await chrome.tabs.query({ active: true, windowId });
  else if (scope === 'window') tabs = (await chrome.tabs.query({ windowId })).filter((t) => !(skipPinned && t.pinned));
  else if (scope === 'tabGroup') tabs = await chrome.tabs.query({ groupId: tabGroupId });
  else if (scope === 'tabIds') tabs = await Promise.all(tabIds.map((id) => chrome.tabs.get(id)));
  else throw new Error(`Unknown scope: ${scope}`);
  return tabs.filter((t) => isSaveableUrl(tabUrl(t)) && !isOwnPage(chrome, tabUrl(t)));
}

/** Finds the window of the tab the user looks at now (for shortcuts and menus). */
export async function focusedWindowId(chrome) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.windowId;
}

/**
 * Saves tabs into a group, then (optionally) closes them.
 * Tabs close only after the storage write completes, so no data is lost.
 *
 * target: { groupId } or { newGroup: { name, color, labels, note } }
 * details: { note, labels, color } applied to each saved bookmark
 */
export async function saveTabs(chrome, store, { tabs, target, details = {}, close = true }) {
  if (!tabs.length) return { groupId: null, added: 0, duplicates: 0, closed: 0 };

  const group = target.newGroup ? await store.addGroup(target.newGroup) : await store.getGroup(target.groupId);
  if (!group || group.deletedAt) throw new Error('Group not found.');

  const items = tabs.map((t) => ({
    // A title typed by the user replaces the page title only for a single tab.
    title: tabs.length === 1 && details.title ? details.title : t.title,
    url: tabUrl(t),
    note: details.note ?? '',
    labels: details.labels ?? [],
    color: details.color,
  }));
  const { added, duplicates } = await store.addBookmarks(group.id, items);
  await store.updateSettings({ lastGroupId: group.id });

  let closed = 0;
  if (close) closed = await closeTabs(chrome, tabs);
  return { groupId: group.id, groupName: group.name, added: added.length, duplicates, closed };
}

/**
 * Closes tabs. If this would close every tab of a window, it first opens a
 * new tab there, so the window (and the browser) stays open.
 */
export async function closeTabs(chrome, tabs) {
  const ids = new Set(tabs.map((t) => t.id));
  const windowIds = [...new Set(tabs.map((t) => t.windowId))];
  for (const windowId of windowIds) {
    const all = await chrome.tabs.query({ windowId });
    if (all.every((t) => ids.has(t.id))) await chrome.tabs.create({ windowId, active: true });
  }
  await chrome.tabs.remove([...ids]);
  return ids.size;
}

/**
 * Opens saved bookmarks.
 * options:
 *   windowId    window to open in (ignored when newWindow)
 *   newWindow   open in a new window
 *   asTabGroup  put the tabs in a native Chrome tab group (title/colour of `group`)
 *   group       the saved group (for the tab group title and colour)
 *   remove      delete the bookmarks that opened successfully ("restore")
 * Returns { opened, failed: [{ bookmark, error }], removed }.
 */
export async function openBookmarks(chrome, store, bookmarks, { windowId, newWindow = false, asTabGroup = false, group = null, remove = false } = {}) {
  const opened = [];
  const failed = [];
  let targetWindow = windowId;
  let firstTabToClose = null;

  if (newWindow && bookmarks.length) {
    const win = await chrome.windows.create({ focused: true });
    targetWindow = win.id;
    firstTabToClose = win.tabs?.[0]?.id ?? null; // the blank tab Chrome opens in a new window
  }

  for (const [i, bookmark] of bookmarks.entries()) {
    try {
      const tab = await chrome.tabs.create({ url: bookmark.url, windowId: targetWindow, active: i === 0 });
      opened.push({ bookmark, tab });
    } catch (error) {
      failed.push({ bookmark, error: String(error?.message ?? error) });
    }
  }

  if (firstTabToClose != null && opened.length) await chrome.tabs.remove(firstTabToClose).catch(() => {});

  if (asTabGroup && group && opened.length && chrome.tabGroups) {
    try {
      const tabGroupId = await chrome.tabs.group({
        tabIds: opened.map((o) => o.tab.id),
        createProperties: { windowId: opened[0].tab.windowId },
      });
      await chrome.tabGroups.update(tabGroupId, {
        title: group.name,
        color: isColor(group.color) ? group.color : 'grey',
      });
    } catch {
      // Grouping is a convenience: the tabs are open even if grouping fails.
    }
  }

  let removed = 0;
  if (remove && opened.length) removed = await store.deleteBookmarks(opened.map((o) => o.bookmark.id));
  return { opened: opened.length, failed, removed };
}

/** Lists the native Chrome tab groups of a window, with their tab counts. */
export async function listTabGroups(chrome, windowId) {
  if (!chrome.tabGroups) return [];
  const groups = await chrome.tabGroups.query({ windowId });
  const tabs = await chrome.tabs.query({ windowId });
  return groups.map((g) => ({
    id: g.id,
    title: g.title || '(unnamed group)',
    color: g.color,
    count: tabs.filter((t) => t.groupId === g.id).length,
  }));
}
