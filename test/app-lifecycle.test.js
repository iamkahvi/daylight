'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
assert.match(appSource, /\nload\(\);\s*$/);
const withoutLoad = appSource.replace(/\nload\(\);\s*$/, '\n');
const scripts = ['solar.js', 'location.js', 'period.js'].map((file) => ({
  file,
  source: fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
}));
const now = Date.parse('2025-06-15T12:00:00Z');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function element() {
  const attributes = new Map();
  const classes = new Set();
  const styleValues = new Map();
  const handlers = new Map();
  return {
    hidden: false, value: '', textContent: '', children: [], clientWidth: 700, offsetWidth: 120,
    style: {
      setProperty(name, value) { styleValues.set(name, String(value)); },
      getPropertyValue(name) { return styleValues.get(name) || ''; }
    },
    classList: {
      add(...names) { names.forEach((name) => classes.add(name)); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
      contains(name) { return classes.has(name); },
      toggle(name, force = !classes.has(name)) { if (force) classes.add(name); else classes.delete(name); return force; }
    },
    setAttribute(name, value) { attributes.set(name, String(value)); if (name === 'hidden') this.hidden = true; },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    removeAttribute(name) { attributes.delete(name); if (name === 'hidden') this.hidden = false; },
    toggleAttribute(name, force = !attributes.has(name)) { if (force) this.setAttribute(name, ''); else this.removeAttribute(name); return force; },
    addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(fn); },
    dispatch(type, event = {}) { return (handlers.get(type) || []).map((fn) => fn(event)).at(-1); },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    contains() { return false; },
    focus() {},
    scrollIntoView() {},
    getBoundingClientRect() { return { left: 0, width: 700, height: 374 }; }
  };
}

function makeDays(start, end, sourceName) {
  const days = [];
  for (let date = start; date <= end;) {
    const midnight = Date.parse(`${date}T00:00:00Z`) / 1000;
    days.push({ date, sunrise: midnight + 6 * 3600, sunset: midnight + 18 * 3600, duration: 12 * 3600, source: sourceName });
    const next = new Date(`${date}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    date = next.toISOString().slice(0, 10);
  }
  return days;
}

function setup({ initialSearch = '', initialPathname = '/', initialHash = '', fetchImpl = async () => { throw new Error('Unexpected fetch'); } } = {}) {
  let nextTimer = 1;
  let nextFrame = 1;
  const timers = new Map();
  const frames = new Map();
  const ids = Object.fromEntries([
    'location-input', 'location-clear', 'location-dropdown', 'chart', 'chart-wrap', 'chart-detail', 'chart-title', 'chart-description', 'chart-toggle', 'app-title', 'retry',
    'period-marker', 'period-start-point', 'period-end-point', 'period-start-label', 'period-end-label', 'period-start-time', 'period-end-time', 'duration', 'period-state', 'period-detail',
    'today-heading', 'current-date', 'location-name', 'chart-status'
  ].map((id) => [id, element()]));
  const selectors = {
    '.location-control': element(), '.period-visual': element(), '.period-duration': element(),
    '.period-fill': element(), '.period-curve': element()
  };
  const documentHandlers = new Map();
  const windowHandlers = new Map();
  const document = {
    title: '', activeElement: null,
    getElementById(id) { assert.ok(ids[id], `unexpected element id: ${id}`); return ids[id]; },
    querySelector(selector) { assert.ok(selectors[selector], `unexpected selector: ${selector}`); return selectors[selector]; },
    querySelectorAll(selector) { assert.equal(selector, '.period-arc'); return [selectors['.period-fill'], selectors['.period-curve']]; },
    createElement() { return element(); },
    addEventListener(type, fn) { if (!documentHandlers.has(type)) documentHandlers.set(type, []); documentHandlers.get(type).push(fn); },
    dispatch(type, event = {}) { for (const fn of documentHandlers.get(type) || []) fn(event); }
  };
  const location = { search: initialSearch, pathname: initialPathname, hash: initialHash };
  const window = {
    document, location,
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    addEventListener(type, fn) { if (!windowHandlers.has(type)) windowHandlers.set(type, []); windowHandlers.get(type).push(fn); },
    dispatch(type, event = {}) { for (const fn of windowHandlers.get(type) || []) fn(event); }
  };
  const historyCalls = [];
  const history = {
    pushState(state, title, url) {
      historyCalls.push({ state, title, url });
      const parsed = new URL(url, 'https://daylight.test');
      location.pathname = parsed.pathname;
      location.search = parsed.search;
      location.hash = parsed.hash;
    }
  };
  function setUrl(url) {
    const parsed = new URL(url, 'https://daylight.test');
    location.pathname = parsed.pathname;
    location.search = parsed.search;
    location.hash = parsed.hash;
  }
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const providerCalls = [];
  const providers = {
    openMeteo: { name: 'mock forecast' }, sunriseSunset: { name: 'mock annual' }, localSolar: { name: 'mock local' },
    getDaysWithFallback(_providers, start, end, selected, signal, kind) {
      const request = deferred();
      providerCalls.push({ start, end, selected: { ...selected }, signal, kind, ...request });
      return request.promise;
    }
  };
  const chartSnapshots = [];
  let chartDays;
  const chart = {
    setMode() {},
    clear() { chartDays = undefined; },
    setData(days) { chartDays = days; snapshot(); },
    redraw() { snapshot(); },
    isPreview() { return false; }
  };
  function snapshot() {
    if (!chartDays) return;
    chartSnapshots.push(chartDays.filter((day) => day.date >= '2025-06-14' && day.date <= '2025-06-16')
      .map((day) => `${day.date}:${day.source}`).join('|'));
  }
  window.DaylightProviders = providers;
  window.DaylightChart = { createChart() { return chart; } };
  const context = vm.createContext({
    document, window, history, Date: ClockDate, URLSearchParams,
    AbortController, ResizeObserver: class { observe() {} },
    setTimeout(fn, delay) { const id = nextTimer++; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(fn) { const id = nextFrame++; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    fetch: (...args) => fetchImpl(...args),
    console: { error() {} },
    getComputedStyle() { return { fontSize: '12px', strokeWidth: '4px' }; }
  });
  for (const { file, source } of scripts) vm.runInContext(source, context, { filename: file });
  vm.runInContext(withoutLoad, context, { filename: 'app.js' });
  return {
    context, ids, window, document, providerCalls, timers, historyCalls, setUrl,
    start() { return context.load(); },
    fireTimer(delay) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `no pending ${delay}ms timer`);
      timers.delete(entry[0]);
      entry[1].fn();
    },
    async flush() { await new Promise((resolve) => setImmediate(resolve)); },
    resolveCall(call, sourceName = call.kind) { call.resolve({ days: makeDays(call.start, call.end, sourceName) }); },
    snapshots() { return chartSnapshots.slice(); }
  };
}

function callOf(app, kind, index = 0) {
  const calls = app.providerCalls.filter((call) => call.kind === kind);
  assert.ok(calls[index], `missing ${kind} request #${index + 1}`);
  return calls[index];
}

test('startup merges adjacent forecast records into annual chart data in either completion order', async (t) => {
  for (const order of [['forecast', 'annual'], ['annual', 'forecast']]) {
    await t.test(`${order.join(' then ')}`, async () => {
      const app = setup({ initialSearch: '?lat=12&lon=34&tz=UTC&n=Query%20Place' });
      const loading = app.start();
      assert.equal(app.ids['location-input'].value, 'Query Place');
      assert.equal(app.ids['location-name'].textContent, 'Query Place');
      assert.equal(app.ids['today-heading'].textContent, 'loading daylight times…');
      assert.deepEqual(app.providerCalls.map(({ kind }) => kind), ['forecast', 'annual']);

      for (const kind of order) {
        app.resolveCall(callOf(app, kind));
        await app.flush();
        if (kind === 'annual' && order[0] === 'annual') {
          assert.equal(app.snapshots().length, 1, 'annual data renders before forecast arrives');
          assert.ok(app.snapshots()[0].includes('2025-06-15:annual'));
        }
      }
      await loading;

      const snapshots = app.snapshots();
      assert.equal(snapshots.at(-1), '2025-06-14:forecast|2025-06-15:forecast|2025-06-16:forecast');
      assert.equal(app.ids['chart-status'].hidden, true);
      assert.equal(app.ids.chart.hidden, false);
      assert.equal(app.ids['chart-wrap'].getAttribute('aria-busy'), 'false');
      if (order[0] === 'annual') assert.equal(snapshots.length, 2, 'forecast arrival redraws the already-rendered chart');
      else assert.equal(snapshots.length, 1, 'annual render sees forecast replacements when forecast arrives first');
    });
  }
});

test('forecast failure does not prevent annual chart data from rendering', async () => {
  const app = setup();
  const loading = app.start();
  const forecast = callOf(app, 'forecast');
  const annual = callOf(app, 'annual');

  forecast.reject(new Error('forecast unavailable'));
  await app.flush();
  assert.equal(app.ids['today-heading'].textContent, 'daylight times unavailable');
  assert.equal(app.ids.retry.hidden, false);

  app.resolveCall(annual);
  await loading;
  assert.equal(app.snapshots().length, 1);
  assert.ok(app.snapshots()[0].includes('2025-06-15:annual'));
  assert.equal(app.ids.chart.hidden, false);
  assert.equal(app.ids['chart-status'].hidden, true);
});

test('annual failure does not prevent forecast daylight data from loading', async () => {
  const app = setup();
  const loading = app.start();
  const forecast = callOf(app, 'forecast');
  const annual = callOf(app, 'annual');

  annual.reject(new Error('annual unavailable'));
  app.resolveCall(forecast);
  await loading;

  assert.equal(app.snapshots().length, 0);
  assert.equal(app.ids.chart.hidden, true);
  assert.match(app.ids['chart-status'].textContent, /Couldn’t load yearly daylight data/);
  assert.equal(app.ids['chart-wrap'].getAttribute('aria-busy'), 'false');
  assert.equal(app.ids.retry.hidden, false);
});

test('retry reloads both independent data requests', async () => {
  const app = setup();
  const firstLoad = app.start();
  const oldForecast = callOf(app, 'forecast');
  const oldAnnual = callOf(app, 'annual');
  oldAnnual.reject(new Error('annual unavailable'));
  app.resolveCall(oldForecast);
  await firstLoad;
  assert.equal(app.ids.retry.hidden, false);

  const retryLoad = app.ids.retry.dispatch('click');
  const forecast = callOf(app, 'forecast', 1);
  const annual = callOf(app, 'annual', 1);
  assert.equal(oldForecast.signal.aborted, true);
  assert.equal(oldAnnual.signal.aborted, true);
  assert.equal(app.ids.retry.hidden, true);
  app.resolveCall(forecast);
  app.resolveCall(annual);
  await retryLoad;

  assert.equal(app.snapshots().at(-1), '2025-06-14:forecast|2025-06-15:forecast|2025-06-16:forecast');
  assert.equal(app.ids.chart.hidden, false);
  assert.equal(app.ids['chart-status'].hidden, true);
});

test('a newer popstate load wins when older provider requests finish late', async () => {
  const app = setup();
  const firstLoad = app.start();
  const oldForecast = callOf(app, 'forecast');
  const oldAnnual = callOf(app, 'annual');

  app.window.location.search = '?lat=48.4&lon=-123.3&tz=America%2FVancouver&n=New%20Place';
  app.window.dispatch('popstate');
  const newForecast = callOf(app, 'forecast', 1);
  const newAnnual = callOf(app, 'annual', 1);
  assert.equal(oldForecast.signal.aborted, true);
  assert.equal(oldAnnual.signal.aborted, true);
  assert.equal(newForecast.selected.name, 'New Place');
  assert.equal(app.ids['location-name'].textContent, 'New Place');

  app.resolveCall(oldForecast);
  app.resolveCall(oldAnnual);
  await app.flush();
  assert.equal(app.snapshots().length, 0, 'stale load does not draw its annual data');
  assert.equal(app.ids['location-name'].textContent, 'New Place');

  app.resolveCall(newAnnual);
  app.resolveCall(newForecast);
  await firstLoad;
  await app.flush();
  assert.equal(app.snapshots().length, 2, 'forecast arrival redraws the latest location chart');
  assert.equal(app.snapshots().at(-1), '2025-06-14:forecast|2025-06-15:forecast|2025-06-16:forecast');
  assert.equal(app.ids['chart-status'].hidden, true);
});

test('invalid URL locations fall back to Victoria', async (t) => {
  const invalidSearches = [
    '?lat=nope&lon=10&tz=UTC',
    '?lat=91&lon=10&tz=UTC',
    '?lat=48&lon=-181&tz=UTC',
    '?lat=48&lon=10&tz=Not%2FA%20Timezone',
    '?lat=48&tz=UTC'
  ];
  for (const initialSearch of invalidSearches) {
    await t.test(initialSearch, async () => {
      const app = setup({ initialSearch });
      const loading = app.start();
      const forecast = callOf(app, 'forecast');
      const annual = callOf(app, 'annual');
      for (const request of [forecast, annual]) {
        assert.equal(request.selected.name, 'Victoria, British Columbia, Canada');
        assert.equal(request.selected.lat, 48.4284);
        assert.equal(request.selected.lon, -123.3656);
        assert.equal(request.selected.tz, 'America/Vancouver');
        app.resolveCall(request);
      }
      assert.equal(app.ids['location-input'].value, 'Victoria, British Columbia, Canada');
      await loading;
    });
  }
});

test('a valid URL location without a name uses the selected-location label', async () => {
  const app = setup({ initialSearch: '?lat=12.5&lon=-45&tz=UTC' });
  const loading = app.start();
  for (const kind of ['forecast', 'annual']) {
    const request = callOf(app, kind);
    assert.equal(request.selected.name, 'Selected location');
    assert.equal(request.selected.lat, 12.5);
    assert.equal(request.selected.lon, -45);
    assert.equal(request.selected.tz, 'UTC');
    app.resolveCall(request);
  }
  assert.equal(app.ids['location-input'].value, 'Selected location');
  assert.equal(app.ids['location-name'].textContent, 'Selected location');
  await loading;
});

test('keyboard selection preserves unrelated URL query and hash and invalidates stale searches', async () => {
  const requests = [];
  const app = setup({
    initialPathname: '/observatory',
    initialHash: '#chart',
    initialSearch: '?utm_source=share&tag=one&tag=two&lat=1&lon=2&tz=UTC&n=Old',
    fetchImpl(url) {
      const request = deferred();
      requests.push({ url, ...request });
      return request.promise;
    }
  });
  const input = app.ids['location-input'];
  input.value = 'Old search';
  input.dispatch('input');
  app.fireTimer(250);
  input.value = 'New search';
  input.dispatch('input');
  app.fireTimer(250);
  assert.equal(requests.length, 2);

  const response = (name, latitude, longitude) => ({
    ok: true,
    async json() { return { results: [{ name, admin1: 'Region', country: 'Country', latitude, longitude, timezone: 'UTC' }] }; }
  });
  requests[1].resolve(response('New City', 20, 30));
  await app.flush();
  assert.deepEqual(app.ids['location-dropdown'].children.map((option) => option.textContent), ['New City, Region, Country']);

  let prevented = 0;
  input.dispatch('keydown', { key: 'ArrowDown', preventDefault() { prevented++; } });
  assert.equal(prevented, 1);
  assert.equal(input.getAttribute('aria-activedescendant'), 'location-option-0');
  input.dispatch('keydown', { key: 'Enter', preventDefault() { prevented++; } });
  assert.equal(prevented, 2);
  assert.equal(app.ids['location-dropdown'].hidden, true);
  assert.equal(input.value, 'New City, Region, Country');
  assert.equal(app.historyCalls.length, 1);

  const pushed = new URL(app.historyCalls[0].url, 'https://daylight.test');
  assert.equal(pushed.pathname, '/observatory');
  assert.equal(pushed.hash, '#chart');
  assert.equal(pushed.searchParams.get('utm_source'), 'share');
  assert.deepEqual(pushed.searchParams.getAll('tag'), ['one', 'two']);
  assert.equal(pushed.searchParams.get('lat'), '20');
  assert.equal(pushed.searchParams.get('lon'), '30');
  assert.equal(pushed.searchParams.get('tz'), 'UTC');
  assert.equal(pushed.searchParams.get('n'), 'New City, Region, Country');
  const loadCalls = app.providerCalls.slice(-2);
  assert.deepEqual(loadCalls.map((call) => call.kind), ['forecast', 'annual']);
  for (const call of loadCalls) {
    assert.equal(call.selected.name, 'New City, Region, Country');
    assert.equal(call.selected.lat, 20);
    assert.equal(call.selected.lon, 30);
  }

  requests[0].resolve(response('Stale City', 40, 50));
  await app.flush();
  assert.equal(app.ids['location-dropdown'].hidden, true, 'an obsolete result cannot reopen the dropdown after selection');
  assert.equal(input.value, 'New City, Region, Country');
  for (const call of loadCalls) app.resolveCall(call);
  await app.flush();
});

test('Escape suppresses a pending geocoding response and restores the current location', async () => {
  const requests = [];
  const app = setup({ fetchImpl(url) {
    const request = deferred();
    requests.push({ url, ...request });
    return request.promise;
  } });
  const input = app.ids['location-input'];
  input.value = 'Victoria search';
  input.dispatch('input');
  app.fireTimer(250);
  assert.equal(requests.length, 1);
  input.dispatch('keydown', { key: 'Escape' });
  assert.equal(app.ids['location-dropdown'].hidden, true);
  assert.equal(input.value, 'Victoria, British Columbia, Canada');

  requests[0].resolve({
    ok: true,
    async json() { return { results: [{ name: 'Late City', latitude: 20, longitude: 30, timezone: 'UTC' }] }; }
  });
  await app.flush();
  assert.equal(app.ids['location-dropdown'].hidden, true);
  assert.equal(input.value, 'Victoria, British Columbia, Canada');
});

test('popstate updates the picker from the navigated URL and starts a load for that location', async () => {
  const app = setup({ initialSearch: '?lat=1&lon=2&tz=UTC&n=Initial' });
  const initialLoad = app.start();
  for (const kind of ['forecast', 'annual']) app.resolveCall(callOf(app, kind));
  await initialLoad;

  app.ids['location-input'].value = 'unfinished search';
  app.ids['location-input'].dispatch('input');
  assert.equal(app.ids['location-dropdown'].hidden, false);
  app.setUrl('/?lat=48.4&lon=-123.3&tz=America%2FVancouver&n=Back%20Forward%20Place');
  app.window.dispatch('popstate');

  assert.equal(app.ids['location-input'].value, 'Back Forward Place');
  assert.equal(app.ids['location-dropdown'].hidden, true);
  const calls = app.providerCalls.slice(-2);
  assert.deepEqual(calls.map((call) => call.kind), ['forecast', 'annual']);
  for (const call of calls) {
    assert.equal(call.selected.name, 'Back Forward Place');
    assert.equal(call.selected.lat, 48.4);
    assert.equal(call.selected.lon, -123.3);
    assert.equal(call.selected.tz, 'America/Vancouver');
    app.resolveCall(call);
  }
  await app.flush();
  assert.equal(app.ids['location-name'].textContent, 'Back Forward Place');
});

test('an obsolete geocoding response cannot replace newer search results', async () => {
  const requests = [];
  const app = setup({ fetchImpl(url) {
    const request = deferred();
    requests.push({ url, ...request });
    return request.promise;
  } });
  app.ids['location-input'].value = 'Old';
  app.ids['location-input'].dispatch('input');
  app.fireTimer(250);
  app.ids['location-input'].value = 'New';
  app.ids['location-input'].dispatch('input');
  app.fireTimer(250);
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /name=Old/);
  assert.match(requests[1].url, /name=New/);

  const response = (name, latitude) => ({
    ok: true,
    async json() { return { results: [{ name, latitude, longitude: 10, timezone: 'UTC' }] }; }
  });
  requests[1].resolve(response('New City', 20));
  await app.flush();
  assert.deepEqual(app.ids['location-dropdown'].children.map((option) => option.textContent), ['New City']);
  requests[0].resolve(response('Old City', 30));
  await app.flush();
  assert.deepEqual(app.ids['location-dropdown'].children.map((option) => option.textContent), ['New City']);
});
