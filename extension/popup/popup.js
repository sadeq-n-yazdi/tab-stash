import { createStore } from '../lib/store.js';
import { collectLabels, normalizeLabels, isRestrictedUrl } from '../lib/model.js';
import { collectTabs, listTabGroups } from '../lib/actions.js';
import { h, faviconUrl, colorPicker, pickedColor, attachLabelSuggestions, sendMessage } from '../lib/ui.js';

const NEW_GROUP = '__new__';
const store = createStore(chrome.storage.local);
const $ = (id) => document.getElementById(id);

const form = $('save-form');
const groupSelect = $('group-select');
const statusEl = $('status');

let currentTab = null;
let windowId = null;
let windowTabCount = 0;
let tabGroups = [];

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

function scope() {
  return form.querySelector('input[name="scope"]:checked').value;
}

function setNewGroupColor(color) {
  $('new-group-color').replaceChildren(colorPicker('group-color', color));
}

function renderGroups(groups, selectedId) {
  groupSelect.replaceChildren(
    ...groups.map((g) => h('option', { value: g.id, selected: g.id === selectedId }, g.name)),
    h('option', { value: NEW_GROUP, selected: !groups.length }, '＋ New group…'),
  );
  syncNewGroup();
}

function syncNewGroup() {
  const isNew = groupSelect.value === NEW_GROUP;
  $('new-group').hidden = !isNew;
  $('new-group-name').required = isNew;
}

function syncScope() {
  const s = scope();
  const single = s === 'current';
  $('page-info').hidden = !single;
  $('page-url').hidden = !single;
  $('restricted-warning').hidden = !single || !isRestrictedUrl(currentTab?.url);
  $('tabgroup-field').hidden = s !== 'tabGroup';
  if (s === 'tabGroup') presetFromTabGroup();
}

function presetFromTabGroup() {
  const g = tabGroups.find((t) => String(t.id) === $('tabgroup-select').value);
  if (!g) return;
  groupSelect.value = NEW_GROUP;
  $('new-group-name').value = g.title === '(unnamed group)' ? '' : g.title;
  setNewGroupColor(g.color);
  syncNewGroup();
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  windowId = tab?.windowId;

  const [{ groups, bookmarks, settings }, windowTabs, nativeGroups] = await Promise.all([
    store.load(),
    collectTabs(chrome, { scope: 'window', windowId, skipPinned: (await store.getSettings()).skipPinned }),
    listTabGroups(chrome, windowId),
  ]);
  windowTabCount = windowTabs.length;
  tabGroups = nativeGroups;

  // Page details (single-tab save).
  const url = tab?.pendingUrl || tab?.url || '';
  $('title').value = tab?.title ?? '';
  $('page-url').textContent = url;
  $('page-url').title = url;
  if (url) $('page-icon').src = faviconUrl(url);
  $('window-label').textContent = `All tabs in window (${windowTabCount})`;

  // Native Chrome tab groups in this window.
  if (tabGroups.length) {
    $('tabgroup-option').hidden = false;
    $('tabgroup-select').replaceChildren(
      ...tabGroups.map((g) => h('option', { value: g.id }, `${g.title} (${g.count} tabs, ${g.color})`)),
    );
    if (tab?.groupId != null && tab.groupId >= 0) $('tabgroup-select').value = String(tab.groupId);
  }

  renderGroups(groups, settings.lastGroupId ?? groups[0]?.id);
  setNewGroupColor('blue');
  $('color').replaceChildren(colorPicker('color', '', { allowAuto: true }));
  attachLabelSuggestions($('labels'), $('label-list'), collectLabels([...groups, ...bookmarks]));
  $('close-after').checked = settings.closeAfterSave;

  syncScope();
  groupSelect.focus();
}

async function save(event) {
  event?.preventDefault();
  const s = scope();
  const isNew = groupSelect.value === NEW_GROUP;
  if (isNew && !$('new-group-name').value.trim()) {
    setStatus('Type a name for the new group.', 'error');
    $('new-group-name').focus();
    return;
  }
  const target = isNew
    ? { newGroup: { name: $('new-group-name').value, color: pickedColor(form, 'group-color') } }
    : { groupId: groupSelect.value };
  const details = {
    title: s === 'current' ? $('title').value : undefined,
    note: $('note').value,
    labels: normalizeLabels($('labels').value),
    color: pickedColor(form, 'color'),
  };
  const message = {
    type: 'save',
    scope: s === 'current' ? 'tabIds' : s,
    tabIds: s === 'current' && currentTab ? [currentTab.id] : undefined,
    tabGroupId: s === 'tabGroup' ? Number($('tabgroup-select').value) : undefined,
    windowId,
    target,
    details,
    close: $('close-after').checked,
  };

  $('save-btn').disabled = true;
  setStatus('Saving…');
  try {
    const result = await sendMessage(message);
    const dup = result.duplicates ? `, ${result.duplicates} already saved` : '';
    setStatus(`Saved ${result.added} to "${result.groupName}"${dup}.`, 'ok');
    setTimeout(() => window.close(), 700);
  } catch (error) {
    setStatus(error.message, 'error');
    $('save-btn').disabled = false;
  }
}

// ---------- events ----------

form.addEventListener('submit', save);
groupSelect.addEventListener('change', syncNewGroup);
form.addEventListener('change', (e) => {
  if (e.target.name === 'scope') syncScope();
});
$('tabgroup-select').addEventListener('change', presetFromTabGroup);
$('close-after').addEventListener('change', (e) => store.updateSettings({ closeAfterSave: e.target.checked }));
$('open-manager').addEventListener('click', async () => {
  await sendMessage({ type: 'open-manager' });
  window.close();
});

document.addEventListener('keydown', (e) => {
  // Ctrl/Cmd+Enter saves from anywhere, including the note field.
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    form.requestSubmit();
    return;
  }
  // Alt+1 / Alt+2 / Alt+3 select what to save.
  if (e.altKey && ['1', '2', '3'].includes(e.key)) {
    const value = { 1: 'current', 2: 'window', 3: 'tabGroup' }[e.key];
    const radio = form.querySelector(`input[name="scope"][value="${value}"]`);
    if (radio && !radio.closest('[hidden]')) {
      e.preventDefault();
      radio.checked = true;
      syncScope();
    }
  }
});

init().catch((error) => setStatus(error.message, 'error'));
