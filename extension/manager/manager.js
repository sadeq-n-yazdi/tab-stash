import { createStore } from '../lib/store.js';
import { COLORS, COLOR_HEX, collectLabels, filterBookmarks, parseImport, isRestrictedUrl } from '../lib/model.js';
import { openBookmarks } from '../lib/actions.js';
import {
  h, faviconUrl, colorDot, colorPicker, pickedColor, labelChips, attachLabelSuggestions, formatDate, hostOf,
} from '../lib/ui.js';

const store = createStore(chrome.storage.local);
const $ = (id) => document.getElementById(id);

const state = {
  groups: [],
  bookmarks: [],
  settings: {},
  groupsById: new Map(),
  filter: { text: '', labels: [], colors: [], groupId: '' },
  selected: new Set(),
};

// ---------- helpers ----------

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = `status ${kind}`;
}

async function guard(fn) {
  try {
    await fn();
  } catch (error) {
    console.error(error);
    setStatus(error.message ?? String(error), 'error');
  }
}

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  state.filter.groupId = params.get('group') ?? '';
}

function writeHash() {
  const params = new URLSearchParams();
  if (state.filter.groupId) params.set('group', state.filter.groupId);
  history.replaceState(null, '', `#${params}`);
}

async function currentWindowId() {
  return (await chrome.windows.getCurrent()).id;
}

// ---------- dialogs ----------

function confirmDialog(text, okLabel = 'Delete') {
  const dialog = $('confirm-dialog');
  $('confirm-text').textContent = text;
  $('confirm-ok').textContent = okLabel;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
  });
}

/**
 * Shows the edit form for a group or bookmark. Resolves with the changed
 * values, or null when the user cancels.
 */
function editDialog(kind, record = {}) {
  const dialog = $('edit-dialog');
  const form = $('edit-form');
  const isBookmark = kind === 'bookmark';
  const allLabels = collectLabels([...state.groups, ...state.bookmarks]);

  const fields = [];
  if (isBookmark) {
    fields.push(
      h('label', { class: 'field' }, 'Title', h('input', { type: 'text', name: 'title', value: record.title ?? '', required: true })),
      h('label', { class: 'field' }, 'URL', h('input', { type: 'url', name: 'url', value: record.url ?? '', required: true })),
      h('label', { class: 'field' }, 'Group',
        h('select', { name: 'groupId' }, state.groups.map((g) => h('option', { value: g.id, selected: g.id === record.groupId }, g.name)))),
    );
  } else {
    fields.push(h('label', { class: 'field' }, 'Name', h('input', { type: 'text', name: 'name', value: record.name ?? '', required: true })));
  }
  const labelsInput = h('input', { type: 'text', name: 'labels', value: (record.labels ?? []).join(', '), list: 'label-list' });
  fields.push(
    h('label', { class: 'field' }, h('span', {}, 'Note ', h('span', { class: 'hint' }, 'optional')),
      h('textarea', { name: 'note', rows: 3 }, record.note ?? '')),
    h('label', { class: 'field' }, h('span', {}, 'Labels ', h('span', { class: 'hint' }, 'comma-separated')), labelsInput),
    h('div', { class: 'field' }, 'Colour', colorPicker('edit-color', record.color ?? 'blue')),
  );

  const heading = record.id ? `Edit ${kind}` : `New ${kind}`;
  form.className = 'dialog-form';
  form.replaceChildren(
    h('h2', {}, heading),
    ...fields,
    h('menu', {},
      h('button', { value: 'cancel', formnovalidate: true }, 'Cancel'),
      h('button', { value: 'save', class: 'primary' }, 'Save')),
  );
  attachLabelSuggestions(labelsInput, $('label-list'), allLabels);
  dialog.returnValue = '';
  dialog.showModal();
  form.querySelector('input')?.focus();

  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      if (dialog.returnValue !== 'save') return resolve(null);
      const data = Object.fromEntries(new FormData(form));
      delete data['edit-color'];
      resolve({ ...data, color: pickedColor(form, 'edit-color') });
    }, { once: true });
  });
}

// ---------- rendering ----------

function renderSidebar() {
  const counts = new Map();
  for (const b of state.bookmarks) counts.set(b.groupId, (counts.get(b.groupId) ?? 0) + 1);

  const item = (id, name, color, count) => h('li', {},
    h('button', {
      type: 'button',
      'aria-current': String(state.filter.groupId === id),
      onclick: () => selectGroup(id),
    },
    color ? colorDot(color) : h('span', { class: 'dot', style: { background: 'transparent' } }),
    h('span', { class: 'name' }, name),
    h('span', { class: 'count' }, count)));

  $('group-list').replaceChildren(
    item('', 'All saved', null, state.bookmarks.length),
    ...state.groups.map((g) => item(g.id, g.name, g.color, counts.get(g.id) ?? 0)),
  );

  const labels = collectLabels([...state.groups, ...state.bookmarks]);
  $('label-filter').replaceChildren(
    ...(labels.length
      ? labelChips(labels.map((l) => l.label), { onClick: toggleLabel, active: state.filter.labels })
      : [h('span', { class: 'hint' }, 'No labels yet.')]),
  );

  $('color-filter').replaceChildren(...COLORS.map((c) => h('button', {
    type: 'button',
    title: c,
    'aria-pressed': String(state.filter.colors.includes(c)),
    style: { background: COLOR_HEX[c] },
    onclick: () => toggleColor(c),
  })));
}

function renderGroupHeader(visibleCount) {
  const group = state.groupsById.get(state.filter.groupId);
  const header = $('group-header');
  if (!group) {
    header.replaceChildren(h('div', { class: 'title-row' }, h('h2', {}, 'All saved'),
      h('span', { class: 'hint' }, `${visibleCount} shown`)));
    return;
  }
  header.replaceChildren(
    h('div', { class: 'title-row' },
      h('h2', {}, colorDot(group.color), group.name),
      h('span', { class: 'hint' }, `${visibleCount} shown · created ${formatDate(group.createdAt)}`),
      h('div', { class: 'actions' },
        h('button', { type: 'button', onclick: () => openGroup(group, { remove: state.settings.removeOnRestore }), title: 'Open every bookmark in this group' }, 'Open all'),
        h('button', { type: 'button', onclick: () => openGroup(group, { remove: true }), title: 'Open all, then remove them from the group' }, 'Restore all'),
        h('button', { type: 'button', onclick: () => openGroup(group, { newWindow: true, remove: state.settings.removeOnRestore }) }, 'New window'),
        h('button', { type: 'button', onclick: () => editGroup(group) }, 'Edit'),
        h('button', { type: 'button', class: 'danger', onclick: () => deleteGroup(group) }, 'Delete'))),
    ...[
      group.note ? h('p', { class: 'note' }, group.note) : null,
      group.labels.length ? h('div', { class: 'chips' }, labelChips(group.labels)) : null,
    ].filter(Boolean), // replaceChildren() would print null as text
  );
}

function renderBulkBar() {
  const bar = $('bulk-bar');
  const n = state.selected.size;
  bar.hidden = n === 0;
  if (!n) return;
  const moveSelect = h('select', { 'aria-label': 'Move to group' },
    h('option', { value: '' }, 'Move to…'),
    state.groups.map((g) => h('option', { value: g.id }, g.name)));
  moveSelect.addEventListener('change', () => moveSelected(moveSelect.value));
  bar.replaceChildren(
    h('strong', {}, `${n} selected`),
    h('button', { type: 'button', onclick: () => openSelected(false) }, 'Open'),
    h('button', { type: 'button', onclick: () => openSelected(true) }, 'Restore'),
    moveSelect,
    h('button', { type: 'button', class: 'danger', onclick: deleteSelected }, 'Delete'),
    h('button', { type: 'button', onclick: () => { state.selected.clear(); render(); } }, 'Clear selection'),
  );
}

function bookmarkItem(b) {
  const group = state.groupsById.get(b.groupId);
  const checkbox = h('input', { type: 'checkbox', 'aria-label': `Select ${b.title}`, checked: state.selected.has(b.id) });
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) state.selected.add(b.id);
    else state.selected.delete(b.id);
    renderBulkBar();
  });
  return h('li', { class: 'bookmark', style: { '--item-color': COLOR_HEX[b.color] } },
    checkbox,
    h('img', { src: faviconUrl(b.url), alt: '', width: 16, height: 16, loading: 'lazy' }),
    h('div', { class: 'body' },
      h('a', { class: 'title', href: b.url, target: '_blank', rel: 'noopener', title: b.url }, b.title),
      h('div', { class: 'meta' },
        h('span', { class: 'url' }, hostOf(b.url)),
        !state.filter.groupId && group ? h('span', {}, colorDot(group.color), ' ', group.name) : null,
        h('span', {}, formatDate(b.createdAt)),
        isRestrictedUrl(b.url) ? h('span', { class: 'warn' }, 'can fail to open') : null),
      b.note ? h('p', { class: 'note' }, b.note) : null,
      b.labels.length ? h('div', { class: 'chips' }, labelChips(b.labels, { onClick: toggleLabel, active: state.filter.labels })) : null),
    h('div', { class: 'row-actions' },
      h('button', { type: 'button', class: 'small', onclick: () => openOne(b, false) }, 'Open'),
      h('button', { type: 'button', class: 'small', title: 'Open and remove from the shelf', onclick: () => openOne(b, true) }, 'Restore'),
      h('button', { type: 'button', class: 'small', onclick: () => editBookmark(b) }, 'Edit'),
      h('button', { type: 'button', class: 'small danger', onclick: () => deleteBookmark(b) }, 'Delete')),
  );
}

function render() {
  // Drop selections that no longer exist.
  const liveIds = new Set(state.bookmarks.map((b) => b.id));
  for (const id of state.selected) if (!liveIds.has(id)) state.selected.delete(id);

  const visible = filterBookmarks(state.bookmarks, state.groupsById, state.filter);
  renderSidebar();
  renderGroupHeader(visible.length);
  renderBulkBar();
  $('bookmark-list').replaceChildren(...visible.map(bookmarkItem));

  const empty = $('empty');
  empty.hidden = visible.length > 0;
  if (!visible.length) {
    const filtering = state.filter.text || state.filter.labels.length || state.filter.colors.length;
    empty.textContent = filtering
      ? 'Nothing matches these filters.'
      : 'Nothing saved here yet. Use the toolbar button, Alt+Shift+S, or right-click a page to save tabs.';
  }
}

async function reload() {
  const data = await store.load();
  state.groups = data.groups;
  state.bookmarks = data.bookmarks;
  state.settings = data.settings;
  state.groupsById = new Map(data.groups.map((g) => [g.id, g]));
  if (state.filter.groupId && !state.groupsById.has(state.filter.groupId)) {
    state.filter.groupId = '';
    writeHash();
  }
  render();
}

async function renderShortcuts() {
  const commands = await chrome.commands.getAll();
  const names = {
    _execute_action: 'Save window (popup)',
    'quick-save-tab': 'Quick save tab',
    'save-window': 'Save all tabs',
    'open-manager': 'Open manager',
  };
  $('shortcut-list').replaceChildren(...commands.map((c) =>
    h('li', {}, h('span', {}, names[c.name] ?? c.description), c.shortcut ? h('kbd', {}, c.shortcut) : h('span', { class: 'hint' }, 'not set'))));
}

// ---------- filter actions ----------

function selectGroup(id) {
  state.filter.groupId = id;
  state.selected.clear();
  writeHash();
  render();
}

function toggleLabel(label) {
  const key = label.toLowerCase();
  const has = state.filter.labels.some((l) => l.toLowerCase() === key);
  state.filter.labels = has ? state.filter.labels.filter((l) => l.toLowerCase() !== key) : [...state.filter.labels, label];
  render();
}

function toggleColor(color) {
  const has = state.filter.colors.includes(color);
  state.filter.colors = has ? state.filter.colors.filter((c) => c !== color) : [...state.filter.colors, color];
  render();
}

// ---------- record actions ----------

async function createGroup() {
  const values = await editDialog('group');
  if (!values) return;
  await guard(async () => {
    const group = await store.addGroup(values);
    await reload();
    selectGroup(group.id);
    setStatus(`Group "${group.name}" created.`, 'ok');
  });
}

async function editGroup(group) {
  const values = await editDialog('group', group);
  if (!values) return;
  await guard(async () => {
    await store.updateGroup(group.id, values);
    setStatus('Group saved.', 'ok');
  });
}

async function deleteGroup(group) {
  const count = state.bookmarks.filter((b) => b.groupId === group.id).length;
  const ok = await confirmDialog(`Delete the group "${group.name}" and its ${count} bookmark(s)?`);
  if (!ok) return;
  await guard(async () => {
    await store.deleteGroup(group.id);
    if (state.settings.lastGroupId === group.id) await store.updateSettings({ lastGroupId: null });
    await store.ensureDefaultGroup();
    selectGroup('');
    setStatus(`Group "${group.name}" deleted.`, 'ok');
  });
}

async function editBookmark(b) {
  const values = await editDialog('bookmark', b);
  if (!values) return;
  await guard(async () => {
    await store.updateBookmark(b.id, values);
    setStatus('Bookmark saved.', 'ok');
  });
}

async function deleteBookmark(b) {
  if (!(await confirmDialog(`Delete "${b.title}"?`))) return;
  await guard(async () => {
    await store.deleteBookmarks([b.id]);
    setStatus('Bookmark deleted.', 'ok');
  });
}

function reportOpen(result, verb) {
  const failed = result.failed.length ? ` ${result.failed.length} could not open: ${result.failed.map((f) => f.bookmark.url).join(', ')}` : '';
  setStatus(`${verb} ${result.opened} tab(s).${result.removed ? ` Removed ${result.removed}.` : ''}${failed}`,
    result.failed.length ? 'error' : 'ok');
}

async function openOne(b, remove) {
  await guard(async () => {
    const result = await openBookmarks(chrome, store, [b], { windowId: await currentWindowId(), remove });
    reportOpen(result, 'Opened');
  });
}

async function openGroup(group, { newWindow = false, remove = false } = {}) {
  const items = filterBookmarks(state.bookmarks, state.groupsById, { ...state.filter, groupId: group.id });
  if (!items.length) return setStatus('No bookmarks to open.');
  await guard(async () => {
    const result = await openBookmarks(chrome, store, items, {
      windowId: await currentWindowId(),
      newWindow,
      asTabGroup: state.settings.restoreAsTabGroup,
      group,
      remove,
    });
    reportOpen(result, remove ? 'Restored' : 'Opened');
  });
}

function selectedBookmarks() {
  return state.bookmarks.filter((b) => state.selected.has(b.id));
}

async function openSelected(remove) {
  await guard(async () => {
    const items = selectedBookmarks();
    const group = state.groupsById.get(state.filter.groupId) ?? null;
    const result = await openBookmarks(chrome, store, items, {
      windowId: await currentWindowId(),
      asTabGroup: Boolean(group) && state.settings.restoreAsTabGroup,
      group,
      remove,
    });
    if (remove) state.selected.clear();
    reportOpen(result, remove ? 'Restored' : 'Opened');
  });
}

async function moveSelected(groupId) {
  if (!groupId) return;
  await guard(async () => {
    const items = selectedBookmarks();
    for (const b of items) await store.updateBookmark(b.id, { groupId });
    state.selected.clear();
    setStatus(`Moved ${items.length} bookmark(s) to "${state.groupsById.get(groupId)?.name}".`, 'ok');
  });
}

async function deleteSelected() {
  const items = selectedBookmarks();
  if (!(await confirmDialog(`Delete ${items.length} selected bookmark(s)?`))) return;
  await guard(async () => {
    await store.deleteBookmarks(items.map((b) => b.id));
    state.selected.clear();
    setStatus(`Deleted ${items.length} bookmark(s).`, 'ok');
  });
}

// ---------- import / export / settings ----------

async function exportAll() {
  const data = await store.exportData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `tab-shelf-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  setStatus(`Exported ${data.groups.length} group(s) and ${data.bookmarks.length} bookmark(s).`, 'ok');
}

async function importFile(file) {
  await guard(async () => {
    const parsed = parseImport(await file.text());
    const result = await store.importData(parsed);
    const skipped = result.skipped ? ` Skipped ${result.skipped} bookmark(s) with an unknown group.` : '';
    setStatus(`Imported ${result.groups} group(s) and ${result.bookmarks} bookmark(s).${skipped}`, 'ok');
  });
}

function openSettings() {
  const dialog = $('settings-dialog');
  const form = $('settings-form');
  for (const input of form.querySelectorAll('input[type="checkbox"]')) input.checked = Boolean(state.settings[input.name]);
  dialog.returnValue = '';
  dialog.showModal();
  dialog.addEventListener('close', () => guard(async () => {
    if (dialog.returnValue !== 'save') return;
    const changes = {};
    for (const input of form.querySelectorAll('input[type="checkbox"]')) changes[input.name] = input.checked;
    await store.updateSettings(changes);
    setStatus('Settings saved.', 'ok');
  }), { once: true });
}

// ---------- events ----------

$('search').addEventListener('input', (e) => {
  state.filter.text = e.target.value;
  render();
});
$('new-group').addEventListener('click', createGroup);
$('export-btn').addEventListener('click', () => guard(exportAll));
$('import-btn').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', (e) => {
  const [file] = e.target.files;
  if (file) importFile(file);
  e.target.value = '';
});
$('settings-btn').addEventListener('click', openSettings);
$('edit-shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
  if (e.key === '/' && !typing && !document.querySelector('dialog[open]')) {
    e.preventDefault();
    $('search').focus();
  } else if (e.key === 'Escape' && document.activeElement === $('search')) {
    $('search').value = '';
    state.filter.text = '';
    render();
  }
});

// Follow changes from the popup, shortcuts, context menus, and other manager tabs.
let reloadTimer;
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area !== 'local') return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => guard(reload), 80);
});
window.addEventListener('hashchange', () => { readHash(); render(); });

readHash();
guard(async () => {
  await store.ensureDefaultGroup();
  await reload();
  await renderShortcuts();
});
