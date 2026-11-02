// Service worker. It keeps no state in memory: every event reads chrome.storage.
// All listeners are registered synchronously at the top level.

import { createStore } from './lib/store.js';
import { collectTabs, saveTabs, focusedWindowId } from './lib/actions.js';
import { GROUP_PREFIX, BOOKMARK_PREFIX } from './lib/model.js';
import { createSync } from './lib/sync.js';
import { createPreviews, indexedDbBackend } from './lib/previews.js';
import { getDeviceId } from './lib/device.js';
import { makeThumbnail } from './lib/thumbnail.js';

const store = createStore(chrome.storage.local);
const previews = createPreviews({ backend: indexedDbBackend() });
const deviceId = () => getDeviceId(chrome.storage.local);
const sync = createSync({
  area: chrome.storage.local, store, fetch: (...args) => fetch(...args), previews, deviceId,
});
const SYNC_SOON = 'sync-soon';
const SYNC_PERIODIC = 'sync-periodic';
const SYNC_DELAY_MINUTES = 0.5; // the shortest delay that chrome.alarms permits
const SYNC_PERIOD_MINUTES = 15;
const MANAGER_URL = chrome.runtime.getURL('manager/manager.html');
const BADGE_ALARM = 'clear-badge';
const MENU_PAGE = 'save-page';
const MENU_LINK = 'save-link';
const MENU_MANAGER = 'open-manager';

// ---------- lifecycle ----------

chrome.runtime.onInstalled.addListener(async () => {
  // Also after an update: an install from before 0.5.0 has no device ID yet.
  await deviceId();
  await store.ensureDefaultGroup();
  await rebuildMenus();
  await sync.purge();
  await startSyncTimer();
});

chrome.runtime.onStartup.addListener(async () => {
  await rebuildMenus();
  await runSync('startup');
  await sync.purge();
  await startSyncTimer();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  // Group names in the context menu must follow changes made on any page.
  if (Object.keys(changes).some((k) => k.startsWith(GROUP_PREFIX) || k === 'settings')) rebuildMenus();
  scheduleSync(changes);
  followDeletions(changes);
  if (changes.settings) followPreviewScope(changes.settings);
});

// ---------- previews ----------

/** Takes a preview of the visible tab, if it is one of the tabs to save. */
async function capturePreview(tabs, settings) {
  if (!settings.savePreviews) return null;
  const tab = tabs.find((t) => t.active);
  if (!tab) return null;
  try {
    // Needs the activeTab grant: a click on the icon, a shortcut or a menu.
    const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 });
    return { url: tab.url, image: await makeThumbnail(shot) };
  } catch (error) {
    // No preview is not an error of the save.
    console.info('[Tab Stash] no preview:', error?.message ?? error);
    return null;
  }
}

async function keepPreview(shot, result, settings) {
  const bookmark = shot && result.addedBookmarks?.find((b) => b.url === shot.url);
  if (!bookmark) return;
  await previews.save(bookmark.id, shot.image, { scope: settings.previewScope, deviceId: await deviceId() });
  if (settings.previewScope !== 'local') await syncSoon();
}

/** A deleted bookmark deletes its preview (here or from another computer). */
async function followDeletions(changes) {
  const ids = Object.entries(changes)
    .filter(([k, c]) => k.startsWith(BOOKMARK_PREFIX) && (c.newValue?.deletedAt || !c.newValue) && !c.oldValue?.deletedAt)
    .map(([k]) => k.slice(BOOKMARK_PREFIX.length));
  if (ids.length && (await previews.deleteFor(ids))) await syncSoon();
}

async function followPreviewScope({ oldValue, newValue }) {
  const scope = newValue?.previewScope;
  if (!scope || scope === (oldValue?.previewScope ?? 'local')) return;
  if (await previews.setScope(scope, await deviceId())) await syncSoon();
}

// ---------- sync ----------

async function runSync(reason) {
  try {
    await sync.syncNow();
  } catch (error) {
    // The sync state keeps the error, and the manager shows it.
    console.warn(`[Tab Stash] sync (${reason}) failed:`, error?.message ?? error);
  }
}

/** Minimum time between two syncs that the user did not ask for. */
const SYNC_STALE_MS = 60_000;

/**
 * Starts a sync if the user is logged in and the last sync is older than one
 * minute. Used when a page opens, when the computer is active again and when
 * the network comes back.
 */
async function syncIfStale(reason) {
  const { token, lastSyncAt } = await sync.getState();
  if (!token) return;
  const last = Date.parse(lastSyncAt || '') || 0;
  if (Date.now() - last < SYNC_STALE_MS) return;
  await runSync(reason);
}

// The computer wakes up, or the user comes back after a pause.
chrome.idle.onStateChanged.addListener((state) => {
  if (state === 'active') syncIfStale('active');
});

// The network comes back (only while the service worker runs).
self.addEventListener('online', () => syncIfStale('online'));

async function startSyncTimer() {
  const { token } = await sync.getState();
  if (!token) return chrome.alarms.clear(SYNC_PERIODIC);
  if (!(await chrome.alarms.get(SYNC_PERIODIC))) {
    await chrome.alarms.create(SYNC_PERIODIC, { periodInMinutes: SYNC_PERIOD_MINUTES });
  }
}

async function syncSoon() {
  const { token } = await sync.getState();
  if (token) await chrome.alarms.create(SYNC_SOON, { delayInMinutes: SYNC_DELAY_MINUTES });
}

/** Starts a sync soon after a local change. Writes of the sync itself do not count. */
async function scheduleSync(changes) {
  const records = Object.entries(changes)
    .filter(([k, c]) => (k.startsWith(GROUP_PREFIX) || k.startsWith(BOOKMARK_PREFIX)) && c.newValue)
    .map(([, c]) => c.newValue);
  if (!records.length) return;
  for (const record of records) {
    if (await sync.needsSync(record)) {
      // A new alarm with the same name replaces the old one: many quick
      // changes give one sync.
      await chrome.alarms.create(SYNC_SOON, { delayInMinutes: SYNC_DELAY_MINUTES });
      return;
    }
  }
}

// ---------- feedback ----------

async function flash(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  await chrome.alarms.create(BADGE_ALARM, { delayInMinutes: 0.5 });
}

async function reportSaved(result) {
  const n = result.added + result.duplicates;
  await flash(n > 0 ? String(n) : '0', '#188038');
  await chrome.action.setTitle({
    title: `Tab Stash: saved ${result.added} tab(s) to "${result.groupName}"` +
      (result.duplicates ? ` (${result.duplicates} already there)` : ''),
  });
}

async function reportError(error) {
  console.error('[Tab Stash]', error);
  await flash('!', '#d93025');
  await chrome.action.setTitle({ title: `Tab Stash error: ${error?.message ?? error}` });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === SYNC_SOON || alarm.name === SYNC_PERIODIC) return runSync(alarm.name);
  if (alarm.name !== BADGE_ALARM) return;
  await chrome.action.setBadgeText({ text: '' });
  await chrome.action.setTitle({ title: 'Tab Stash' });
});

// ---------- core save ----------

async function save({ scope, windowId, tabGroupId, tabIds, target, details, close }) {
  const settings = await store.getSettings();
  const resolvedWindow = windowId ?? (await focusedWindowId(chrome));
  const tabs = await collectTabs(chrome, { scope, windowId: resolvedWindow, tabGroupId, tabIds, skipPinned: settings.skipPinned });
  if (!tabs.length) throw new Error('No tabs to save on this page.');
  let resolvedTarget = target;
  if (!resolvedTarget) resolvedTarget = { groupId: (await store.ensureDefaultGroup()).id };
  // Take the picture first: the save can close the tab.
  const shot = await capturePreview(tabs, settings);
  const result = await saveTabs(chrome, store, {
    tabs, target: resolvedTarget, details, close: close ?? settings.closeAfterSave,
  });
  await keepPreview(shot, result, settings).catch((error) => console.warn('[Tab Stash] preview not kept:', error));
  await reportSaved(result);
  const { addedBookmarks, ...summary } = result;
  return summary;
}

async function openManager() {
  const [existing] = await chrome.tabs.query({ url: `${MANAGER_URL}*` });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: MANAGER_URL });
  }
}

// ---------- keyboard shortcuts ----------

chrome.commands.onCommand.addListener(async (command) => {
  try {
    if (command === 'quick-save-tab') await save({ scope: 'current' });
    else if (command === 'save-window') await save({ scope: 'window' });
    else if (command === 'open-manager') await openManager();
  } catch (error) {
    await reportError(error);
  }
});

// ---------- context menus ----------

let menuBuild = Promise.resolve();

function rebuildMenus() {
  // Serialize rebuilds so that two quick changes cannot create duplicate ids.
  menuBuild = menuBuild.then(buildMenus).catch((e) => console.error('[Tab Stash] menu', e));
  return menuBuild;
}

function createMenu(props) {
  return new Promise((resolve) => {
    chrome.contextMenus.create(props, () => {
      void chrome.runtime.lastError; // ignore "duplicate id" during fast rebuilds
      resolve();
    });
  });
}

async function buildMenus() {
  await chrome.contextMenus.removeAll();
  const { groups, settings } = await store.load();
  const closeText = settings.closeAfterSave ? 'Save tab and close' : 'Save tab';
  await createMenu({ id: MENU_PAGE, title: `${closeText} to Tab Stash`, contexts: ['page'] });
  await createMenu({ id: MENU_LINK, title: 'Save link to Tab Stash', contexts: ['link'] });
  for (const g of groups) {
    const mark = g.id === settings.lastGroupId ? ' ★' : '';
    await createMenu({ id: `${MENU_PAGE}:${g.id}`, parentId: MENU_PAGE, title: g.name + mark, contexts: ['page'] });
    await createMenu({ id: `${MENU_LINK}:${g.id}`, parentId: MENU_LINK, title: g.name + mark, contexts: ['link'] });
  }
  await createMenu({ id: MENU_MANAGER, title: 'Open Tab Stash manager', contexts: ['action'] });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    const id = String(info.menuItemId);
    if (id === MENU_MANAGER) return await openManager();
    const [kind, groupId] = id.split(':');
    if (!groupId) return;
    if (kind === MENU_PAGE && tab) {
      await save({ scope: 'tabIds', tabIds: [tab.id], target: { groupId } });
    } else if (kind === MENU_LINK && info.linkUrl) {
      const { added, duplicates } = await store.addBookmarks(groupId, [
        { title: info.selectionText || info.linkUrl, url: info.linkUrl },
      ]);
      const group = await store.getGroup(groupId);
      await store.updateSettings({ lastGroupId: groupId });
      await reportSaved({ added: added.length, duplicates, groupName: group?.name ?? '' });
    }
  } catch (error) {
    await reportError(error);
  }
});

// ---------- messages from the popup and the manager ----------

async function handleSyncMessage(message) {
  if (message.type === 'sync-login') {
    const platform = navigator.userAgentData?.platform || 'Chrome';
    await sync.login({
      serverUrl: message.serverUrl,
      username: message.username,
      password: message.password,
      client: `Tab Stash on ${platform}`,
    });
  } else if (message.type === 'sync-logout') {
    await sync.logout();
    await chrome.alarms.clear(SYNC_SOON);
  } else if (message.type === 'sync-now') {
    await sync.syncNow();
  } else if (message.type === 'sync-check') {
    await syncIfStale('page');
  } else {
    throw new Error(`Unknown message: ${message.type}`);
  }
  await startSyncTimer();
  const { token, ...rest } = await sync.getState();
  return { ...rest, known: undefined, signedIn: Boolean(token) };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (String(message?.type).startsWith('sync-')) {
      // Sync errors go to the manager only. They do not flash the icon.
      try {
        sendResponse({ ok: true, result: await handleSyncMessage(message) });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message ?? error) });
      }
      return;
    }
    try {
      if (message?.type === 'save') return sendResponse({ ok: true, result: await save(message) });
      if (message?.type === 'open-manager') return sendResponse({ ok: true, result: await openManager() });
      sendResponse({ ok: false, error: `Unknown message: ${message?.type}` });
    } catch (error) {
      await reportError(error);
      sendResponse({ ok: false, error: String(error?.message ?? error) });
    }
  })();
  return true; // the response is sent asynchronously
});
