// Service worker. It keeps no state in memory: every event reads chrome.storage.
// All listeners are registered synchronously at the top level.

import { createStore } from './lib/store.js';
import { collectTabs, saveTabs, focusedWindowId } from './lib/actions.js';
import { GROUP_PREFIX } from './lib/model.js';

const store = createStore(chrome.storage.local);
const MANAGER_URL = chrome.runtime.getURL('manager/manager.html');
const BADGE_ALARM = 'clear-badge';
const MENU_PAGE = 'save-page';
const MENU_LINK = 'save-link';
const MENU_MANAGER = 'open-manager';

// ---------- lifecycle ----------

chrome.runtime.onInstalled.addListener(async () => {
  await store.ensureDefaultGroup();
  await rebuildMenus();
  await store.purgeDeleted();
});

chrome.runtime.onStartup.addListener(async () => {
  await rebuildMenus();
  await store.purgeDeleted();
});

// Group names in the context menu must follow changes made on any page.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some((k) => k.startsWith(GROUP_PREFIX) || k === 'settings')) {
    rebuildMenus();
  }
});

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
  const result = await saveTabs(chrome, store, {
    tabs, target: resolvedTarget, details, close: close ?? settings.closeAfterSave,
  });
  await reportSaved(result);
  return result;
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
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
