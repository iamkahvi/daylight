const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'theme.js'), 'utf8');

function setup({ dark = false, saved = null, blocked = false } = {}) {
  const listeners = {};
  const system = { matches: dark, addEventListener: (name, fn) => { listeners[`system:${name}`] = fn; } };
  const meta = { content: '' };
  const button = {
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, fn) { listeners[`button:${name}`] = fn; }
  };
  const document = {
    documentElement: { dataset: {} },
    querySelector: () => meta,
    getElementById: () => ready ? button : null,
    addEventListener: (name, fn) => { listeners[`document:${name}`] = fn; }
  };
  const window = {
    matchMedia: () => system,
    addEventListener: (name, fn) => { listeners[`window:${name}`] = fn; }
  };
  const localStorage = {
    getItem() { if (blocked) throw new Error('blocked'); return saved; },
    setItem(key, value) { if (blocked) throw new Error('blocked'); saved = value; }
  };
  let ready = false;
  vm.runInNewContext(source, { document, window, localStorage });
  return {
    document, button, meta, system, listeners,
    ready() { ready = true; listeners['document:DOMContentLoaded'](); },
    saved: () => saved
  };
}

test('follows the system until the user chooses a theme', () => {
  const app = setup({ dark: true });
  assert.equal(app.document.documentElement.dataset.theme, 'dark');
  assert.equal(app.meta.content, '#121518');
  app.ready();
  assert.equal(app.button.attributes['aria-label'], 'Switch to light mode');
  app.system.matches = false;
  app.listeners['system:change']();
  assert.equal(app.document.documentElement.dataset.theme, 'light');
  app.listeners['button:click']();
  assert.equal(app.document.documentElement.dataset.theme, 'dark');
  assert.equal(app.saved(), 'dark');
  assert.equal(app.button.title, 'Switch to light mode');
  app.system.matches = true;
  app.listeners['system:change']();
  app.system.matches = false;
  app.listeners['system:change']();
  assert.equal(app.document.documentElement.dataset.theme, 'dark');
});

test('saved choice wins on startup and is synchronized across tabs', () => {
  const app = setup({ dark: true, saved: 'light' });
  assert.equal(app.document.documentElement.dataset.theme, 'light');
  assert.equal(app.meta.content, '#f9f9f9');
  app.ready();
  app.listeners['window:storage']({ key: 'daylight-theme', newValue: 'dark' });
  assert.equal(app.document.documentElement.dataset.theme, 'dark');
  assert.equal(app.button.attributes['aria-label'], 'Switch to light mode');
  app.listeners['window:storage']({ key: 'daylight-theme', newValue: null });
  assert.equal(app.document.documentElement.dataset.theme, 'dark');
  app.system.matches = false;
  app.listeners['system:change']();
  assert.equal(app.document.documentElement.dataset.theme, 'light');
});

test('invalid or unavailable storage falls back to the system and toggle still works', () => {
  assert.equal(setup({ dark: true, saved: 'invalid' }).document.documentElement.dataset.theme, 'dark');
  const app = setup({ blocked: true });
  app.ready();
  app.listeners['button:click']();
  assert.equal(app.document.documentElement.dataset.theme, 'dark');
  assert.equal(app.button.attributes['aria-label'], 'Switch to light mode');
});
