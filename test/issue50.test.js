// #50: dark mode, on by default, with a toggle that remembers the choice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  THEME_KEY, normalizeTheme, nextTheme, themeToggleLabel, themeToggleIcon, loadTheme, saveTheme,
} from '../public/logic.js';

const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

const LIGHT_SEL = ':root';
const DARK_SEL = ':root[data-theme="dark"]';
const COLOUR = /#[0-9a-f]{3,8}\b|rgba?\(/i;

// Every top-level rule as { selector, body }.
function rules(text) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(text.replace(/\/\*[\s\S]*?\*\//g, '')))) out.push({ selector: m[1].trim(), body: m[2] });
  return out;
}

function vars(selector) {
  const rule = rules(css).find((r) => r.selector === selector);
  assert.ok(rule, `missing ${selector} block`);
  return Object.fromEntries([...rule.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

test('#50 AC1: no literal colours outside the two theme blocks', () => {
  const offenders = rules(css)
    .filter((r) => r.selector !== LIGHT_SEL && r.selector !== DARK_SEL)
    .filter((r) => COLOUR.test(r.body))
    .map((r) => r.selector);
  assert.deepEqual(offenders, []);
});

test('#50 AC2: the dark block defines exactly the variables of the light block', () => {
  const light = Object.keys(vars(LIGHT_SEL)).sort();
  const dark = Object.keys(vars(DARK_SEL)).sort();
  assert.ok(light.includes('--on-accent'));
  assert.deepEqual(dark, light);
  assert.match(rules(css).find((r) => r.selector === DARK_SEL).body, /color-scheme:\s*dark/);
  assert.match(rules(css).find((r) => r.selector === LIGHT_SEL).body, /color-scheme:\s*light/);
});

test('#50 the light theme keeps today\'s colours', () => {
  const light = vars(LIGHT_SEL);
  assert.deepEqual(
    [light['--bg'], light['--text'], light['--accent'], light['--on-accent'], light['--surface'], light['--code-bg'], light['--overlay']],
    ['#faf9f5', '#29261b', '#c96442', '#fff', '#fff', '#f5f4ef', 'rgba(0, 0, 0, 0.3)'],
  );
});

const hex = (h) => {
  let s = h.slice(1);
  if (s.length === 3) s = [...s].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};
const luminance = (h) => {
  const [r, g, b] = hex(h).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('#50 AC5: dark text, muted text and accent meet WCAG AA', () => {
  const dark = vars(DARK_SEL);
  const pairs = [];
  for (const fg of ['--text', '--muted', '--accent']) {
    for (const bg of ['--bg', '--user-bubble', '--assistant-bubble']) pairs.push([fg, bg]);
  }
  pairs.push(['--on-accent', '--accent'], ['--on-accent', '--accent-hover'], ['--error', '--error-bg']);
  for (const [fg, bg] of pairs) {
    const ratio = contrast(dark[fg], dark[bg]);
    assert.ok(ratio >= 4.5, `${fg} on ${bg}: ${ratio.toFixed(2)}`);
  }
});

test('#50 the dark accent is the same hue as #c96442, only lighter', () => {
  const hue = (h) => {
    const [r, g, b] = hex(h).map((v) => v / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    return 60 * (((g - b) / (max - min)) % 6);
  };
  const accent = vars(DARK_SEL)['--accent'];
  assert.ok(Math.abs(hue(accent) - hue('#c96442')) < 1.5, accent);
  assert.ok(luminance(accent) > luminance('#c96442'));
});

// ---- AC3: the inline script in <head> ----

function inlineScript() {
  const head = html.slice(0, html.indexOf('</head>'));
  const m = head.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'an inline <script> without src in <head>');
  return { code: m[1], index: m.index };
}

function runInline(storage) {
  const attrs = {};
  const document = { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } };
  const context = { document };
  Object.defineProperty(context, 'localStorage', { get: storage, enumerable: true });
  vm.runInNewContext(inlineScript().code, context);
  return attrs['data-theme'];
}

const mapStorage = (data) => () => ({ getItem: (k) => (k in data ? data[k] : null), setItem() {} });

test('#50 AC3: the inline script comes before the stylesheet link', () => {
  const link = html.indexOf('<link rel="stylesheet"');
  assert.ok(link > 0);
  assert.ok(inlineScript().index < link);
});

test('#50 AC3: the inline script sets dark by default and light only when saved', () => {
  assert.equal(runInline(mapStorage({})), 'dark');
  assert.equal(runInline(mapStorage({ 'polyprompt.theme': 'light' })), 'light');
  assert.equal(runInline(mapStorage({ 'polyprompt.theme': 'dark' })), 'dark');
  assert.equal(runInline(mapStorage({ 'polyprompt.theme': 'purple' })), 'dark');
  assert.equal(runInline(() => ({ getItem() { throw new Error('blocked'); } })), 'dark');
  assert.equal(runInline(() => { throw new Error('SecurityError'); }), 'dark');
});

test('#50 the theme toggle sits in the sidebar', () => {
  const sidebar = html.slice(html.indexOf('<aside'), html.indexOf('</aside>'));
  assert.match(sidebar, /<button id="theme-toggle" class="theme-toggle" type="button">/);
});

// ---- AC4: pure helpers ----

test('#50 theme helpers', () => {
  assert.equal(THEME_KEY, 'polyprompt.theme');
  assert.deepEqual(['dark', 'light', 'x', null, undefined].map(normalizeTheme), ['dark', 'light', 'dark', 'dark', 'dark']);
  assert.equal(nextTheme('dark'), 'light');
  assert.equal(nextTheme('light'), 'dark');
  assert.equal(nextTheme('weird'), 'light');
  assert.equal(themeToggleLabel('dark'), 'โหมดสว่าง');
  assert.equal(themeToggleLabel('light'), 'โหมดมืด');
  assert.notEqual(themeToggleIcon('dark'), themeToggleIcon('light'));

  const data = {};
  const store = () => ({ getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } });
  assert.equal(loadTheme(store), 'dark');
  saveTheme(store, 'light');
  assert.equal(data['polyprompt.theme'], 'light');
  assert.equal(loadTheme(store), 'light');
  data['polyprompt.theme'] = 'blue';
  assert.equal(loadTheme(store), 'dark');

  const broken = () => { throw new Error('blocked'); };
  assert.equal(loadTheme(broken), 'dark');
  assert.doesNotThrow(() => saveTheme(broken, 'light'));
});

// ---- AC4: public/app.js with a fake DOM ----

class El {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.style = {};
    this.listeners = {};
    this.attrs = {};
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    const cls = new Set();
    this.classList = { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), add: (c) => cls.add(c) };
  }
  append(...c) { this.children.push(...c); }
  replaceChildren(...c) { this.children = c; }
  addEventListener(e, f) { this.listeners[e] = f; }
  setAttribute(k, v) { this.attrs[k] = v; }
  focus() {}
}

test('#50 a stored light loads light; the toggle flips, saves and retitles, even without storage', async () => {
  const byId = {};
  const html = new El('html');
  const data = { 'polyprompt.theme': 'light' };
  let storageBroken = false;
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get: () => {
      if (storageBroken) throw new Error('SecurityError');
      return { getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
    },
  });
  globalThis.document = {
    documentElement: html,
    getElementById: (id) => (byId[id] ??= new El(id)),
    createElement: (t) => new El(t),
  };
  globalThis.fetch = async (url) => {
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (url === '/api/status') return json({ model: { state: 'ready', progress: 1, error: null, size: '4b' }, switch: null });
    if (url === '/api/settings') return json({ translatorSize: '4b', claudeModel: 'default', downloadedSizes: ['4b'] });
    if (url === '/api/chats') return json([]);
    return { ok: false, status: 404, json: async () => ({}) };
  };

  try {
    await import('../public/app.js');
    const toggle = byId['theme-toggle'];
    assert.equal(html.attrs['data-theme'], 'light');
    assert.equal(toggle.title, 'โหมดมืด');

    toggle.listeners.click();
    assert.equal(html.attrs['data-theme'], 'dark');
    assert.equal(data['polyprompt.theme'], 'dark');
    assert.equal(toggle.title, 'โหมดสว่าง');
    assert.equal(toggle.attrs['aria-label'], 'โหมดสว่าง');

    toggle.listeners.click();
    assert.equal(html.attrs['data-theme'], 'light');
    assert.equal(data['polyprompt.theme'], 'light');
    assert.equal(toggle.title, 'โหมดมืด');

    // Blocked storage: the toggle still works for the session and logs nothing.
    storageBroken = true;
    toggle.listeners.click();
    assert.equal(html.attrs['data-theme'], 'dark');
    assert.equal(toggle.title, 'โหมดสว่าง');
    assert.equal(data['polyprompt.theme'], 'light', 'nothing saved');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(errors, []);
  } finally {
    console.error = origError;
  }
});
