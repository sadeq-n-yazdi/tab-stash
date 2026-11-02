// Small DOM helpers shared by the popup and the manager.
// User data is always set with textContent / attributes, never innerHTML.

import { COLORS, COLOR_HEX } from './model.js';

/** h('div', { class: 'x', onclick: fn }, child, 'text', ...) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') {
      for (const [prop, v] of Object.entries(value)) {
        if (v == null) continue;
        if (prop.startsWith('--')) el.style.setProperty(prop, v);
        else el.style[prop] = v;
      }
    }
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function faviconUrl(pageUrl, size = 16) {
  const url = new URL(chrome.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', String(size));
  return url.toString();
}

export function colorDot(color, title = color) {
  return h('span', { class: 'dot', title, style: { background: COLOR_HEX[color] ?? COLOR_HEX.grey } });
}

/**
 * A keyboard-friendly colour picker made of radio buttons
 * (arrow keys move between colours). `allowAuto` adds a "same as group" choice.
 */
export function colorPicker(name, selected, { allowAuto = false } = {}) {
  const options = allowAuto ? ['', ...COLORS] : COLORS;
  const wrap = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Colour' });
  for (const color of options) {
    const id = `${name}-${color || 'auto'}`;
    const input = h('input', { type: 'radio', name, id, value: color, checked: color === (selected ?? '') });
    const label = h('label', {
      for: id,
      class: color ? 'swatch' : 'swatch auto',
      title: color || 'Same as group',
      style: color ? { background: COLOR_HEX[color] } : null,
    }, color ? '' : 'auto');
    wrap.append(input, label);
  }
  return wrap;
}

export function pickedColor(form, name) {
  return form.querySelector(`input[name="${name}"]:checked`)?.value || undefined;
}

export function labelChips(labels, { onClick, active = [] } = {}) {
  const activeSet = new Set(active.map((l) => l.toLowerCase()));
  return labels.map((label) =>
    h(onClick ? 'button' : 'span', {
      type: onClick ? 'button' : null,
      class: `chip${activeSet.has(label.toLowerCase()) ? ' active' : ''}`,
      onclick: onClick ? () => onClick(label) : null,
    }, label),
  );
}

/** Fills a <datalist> with label suggestions. */
export function fillDatalist(datalist, labels) {
  datalist.replaceChildren(...labels.map((l) => h('option', { value: l.label ?? l })));
}

/**
 * Label suggestions for a comma-separated input: the suggestions keep the
 * labels that are already typed, so choosing one appends it.
 */
export function attachLabelSuggestions(input, datalist, allLabels) {
  const update = () => {
    const parts = input.value.split(',');
    const done = parts.slice(0, -1).map((p) => p.trim()).filter(Boolean);
    const prefix = done.length ? `${done.join(', ')}, ` : '';
    const doneSet = new Set(done.map((d) => d.toLowerCase()));
    datalist.replaceChildren(
      ...allLabels
        .filter((l) => !doneSet.has(l.label.toLowerCase()))
        .map((l) => h('option', { value: prefix + l.label })),
    );
  };
  input.addEventListener('input', update);
  update();
}

export async function sendMessage(message) {
  const res = await chrome.runtime.sendMessage(message);
  if (!res?.ok) throw new Error(res?.error ?? 'No response from the extension.');
  return res.result;
}

export function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

export function hostOf(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
