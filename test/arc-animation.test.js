'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
// Run the real script and its declarations, but not the final network-backed load.
assert.match(source, /\nload\(\);\s*$/);
const withoutLoad = source.replace(/\nload\(\);\s*$/, '\n');
const epoch = Date.parse('2025-06-21T12:00:00Z');
const hour = 3600;

function element({ hidden = false, clientWidth = 0, offsetWidth = 0 } = {}) {
  const attributes = new Map();
  const classes = new Set();
  const properties = new Map();
  const handlers = new Map();
  const el = {
    hidden, clientWidth, offsetWidth, textContent: '', children: [],
    style: {
      setProperty(name, value) { properties.set(name, String(value)); },
      getPropertyValue(name) { return properties.get(name) || ''; },
      removeProperty(name) { const value = properties.get(name) || ''; properties.delete(name); return value; }
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
    toggleAttribute(name, force = !(name === 'hidden' ? this.hidden : attributes.has(name))) {
      if (force) this.setAttribute(name, ''); else this.removeAttribute(name);
      return force;
    },
    addEventListener(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },
    dispatch(type, event = {}) { for (const fn of handlers.get(type) || []) fn(event); },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    getBoundingClientRect() { return { left: 0, width: 700, height: 374 }; },
    getComputedTextLength() { return 80; },
    contains() { return false; }
  };
  return el;
}

function setup({ reduced = false } = {}) {
  let time = 0;
  let nextId = 1;
  let requests = 0;
  let cancellations = 0;
  let lastUpdateTime = epoch / 1000;
  const frames = new Map();
  const listeners = new Set();
  const motion = {
    matches: reduced,
    addEventListener(type, fn) { if (type === 'change') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'change') listeners.delete(fn); },
    addListener(fn) { listeners.add(fn); },
    removeListener(fn) { listeners.delete(fn); }
  };
  const mediaQueries = [];
  const requestAnimationFrame = (fn) => { const id = nextId++; requests++; frames.set(id, fn); return id; };
  const cancelAnimationFrame = (id) => { cancellations++; frames.delete(id); };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [epoch + time])); }
    static now() { return epoch + time; }
  }

  const ids = Object.fromEntries([
    'location-input', 'location-clear', 'location-dropdown', 'chart', 'chart-wrap', 'chart-detail', 'retry',
    'period-marker', 'period-start-point', 'period-end-point', 'period-start-label', 'period-end-label',
    'period-start-time', 'period-end-time', 'duration', 'period-state', 'period-detail'
  ].map((id) => [id, element({ hidden: id === 'period-marker' || id.endsWith('-point') })]));
  const visual = element({ clientWidth: 700 });
  const duration = element({ offsetWidth: 120 });
  const fill = element({ hidden: true });
  const curve = element({ hidden: true });
  fill.setAttribute('d', 'M130 118 Q350 -60 570 118 Z');
  curve.setAttribute('d', 'M130 118 Q350 -60 570 118');
  const selectors = {
    '.location-control': element(), '.period-visual': visual, '.period-duration': duration,
    '.period-fill': fill, '.period-curve': curve
  };
  const document = {
    getElementById(id) { assert.ok(ids[id], `unexpected element id: ${id}`); return ids[id]; },
    querySelector(selector) { assert.ok(selectors[selector], `unexpected selector: ${selector}`); return selectors[selector]; },
    querySelectorAll(selector) { assert.equal(selector, '.period-arc'); return [fill, curve]; },
    createElementNS() { return element(); },
    addEventListener() {}
  };
  const performance = { now: () => time };
  const window = {
    document, performance, requestAnimationFrame, cancelAnimationFrame,
    location: { search: '', pathname: '/', hash: '' },
    matchMedia(query) {
      mediaQueries.push(query);
      return query === '(prefers-reduced-motion: reduce)' ? motion : { matches: false, addEventListener() {}, addListener() {} };
    },
    addEventListener() {}
  };
  const context = vm.createContext({
    document, window, Date: ClockDate, performance, requestAnimationFrame, cancelAnimationFrame,
    getComputedStyle() { return { fontSize: '12px' }; },
    ResizeObserver: class { observe() {} }, URLSearchParams,
    fetch() { throw new Error('The arc test must not access the network'); }
  });
  vm.runInContext(withoutLoad, context, { filename: 'app.js' });

  return {
    ids, visual, fill, curve, mediaQueries,
    formatTime: (timestamp, timeZone) => context.formatTime(timestamp, timeZone),
    formatDuration: (seconds) => context.formatDuration(seconds),
    formatDurationDifference: (seconds, todaySeconds) => context.formatDurationDifference(seconds, todaySeconds),
    update(day, previous = null, next = null, preview = false) {
      lastUpdateTime = (epoch + time) / 1000;
      context.updateDaylightVisual(day, previous, next, 'UTC', preview);
    },
    renderChart(days, current) {
      context.__testDays = days;
      context.__testCurrent = current;
      vm.runInContext(`updateCurrentVisual = () => updateDaylightVisual(__testCurrent, null, null, 'UTC');
        renderChart(__testDays, __testCurrent.date, 'UTC');`, context);
      const hitArea = ids.chart.children.find((child) => child.getAttribute('class') === 'chart-hit');
      assert.ok(hitArea, 'chart has an interactive hit area');
      return hitArea;
    },
    redrawChart() { vm.runInContext('redrawChart()', context); },
    setReduced(value) { motion.matches = value; for (const fn of listeners) fn({ matches: value, media: '(prefers-reduced-motion: reduce)' }); },
    pending: () => frames.size,
    requests: () => requests,
    cancellations: () => cancellations,
    now: () => (epoch + time) / 1000,
    lastUpdateTime: () => lastUpdateTime,
    // A frame runs only callbacks already queued, like a browser's RAF batch.
    tick(ms = 16) {
      time += ms;
      const batch = [...frames.keys()];
      for (const id of batch) {
        const fn = frames.get(id);
        if (fn) { frames.delete(id); fn(time); }
      }
    },
    finish() {
      for (let i = 0; this.pending() && i < 1000; i++) this.tick();
      assert.equal(this.pending(), 0, 'animation did not settle within 16 seconds');
    }
  };
}

test('times and durations use their respective formats', () => {
  const app = setup();
  assert.equal(app.formatTime(Date.parse('2025-06-21T17:50:00Z') / 1000, 'UTC'), '05:50PM');
  assert.equal(app.formatTime(Date.parse('2025-06-21T00:05:00Z') / 1000, 'UTC'), '12:05AM');
  assert.equal(app.formatTime(Date.parse('2025-06-21T17:50:00Z') / 1000, 'America/Vancouver'), '10:50AM');
  assert.equal(app.formatTime(null, 'UTC'), '—');
  assert.equal(app.formatDuration(59 * 60 + 40), '1h00m');
  assert.equal(app.formatDuration(86400), '24h00m');
  assert.equal(app.formatDurationDifference(8 * 3600 + 300, 9 * 3600), '-55m');
  assert.equal(app.formatDurationDifference(10 * 3600 + 55 * 60, 9 * 3600), '+1h55m');
  assert.equal(app.formatDurationDifference(10 * 3600, 9 * 3600), '+1h00m');
  assert.equal(app.formatDurationDifference(9 * 3600, 9 * 3600), '0m');
  app.update(day(8), null, null, true);
  assert.equal(app.ids.duration.getAttribute('aria-label'), 'daylight: 8 hours 0 minutes');
});

// Make a real period around the fixed clock, with a controllable elapsed fraction.
function day(hours, progress = 0.25) {
  const duration = hours * hour;
  const sunrise = epoch / 1000 - duration * progress;
  return { date: '2025-06-21', sunrise, sunset: sunrise + duration, duration };
}

function targetWidth(hours) {
  return 440 * Math.min(18 * 60, Math.max(0, Math.round(hours * 60))) / (18 * 60);
}

function near(actual, expected, message, tolerance = 1e-6) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected}, got ${actual}`);
}

function geometry(app) {
  const path = app.curve.getAttribute('d');
  const number = '([-+]?(?:\\d*\\.)?\\d+(?:[eE][-+]?\\d+)?)';
  const match = new RegExp(`^M\\s*${number}[,\\s]+118\\s+Q\\s*350[,\\s]+-60[,\\s]+${number}[,\\s]+118$`).exec(path);
  assert.ok(match, `unexpected curve path: ${path}`);
  const start = Number(match[1]), end = Number(match[2]);
  assert.equal(app.fill.getAttribute('d'), `${path} Z`, 'fill follows the curve');
  near((start + end) / 2, 350, 'arc remains centered');
  near(parseFloat(app.visual.style.getPropertyValue('--period-start-x')), start / 7, 'start point follows arc');
  near(parseFloat(app.visual.style.getPropertyValue('--period-end-x')), end / 7, 'end point follows arc');
  assert.equal(app.visual.classList.contains('is-narrow'), end - start < 136, 'narrow class follows rendered width');
  return { start, end, width: end - start };
}

function checkMarker(app, period) {
  assert.equal(app.ids['period-marker'].hidden, false);
  const { start, width } = geometry(app);
  // After the animation settles, its last frame can predate the current clock.
  // A captured update-time progress is also valid until the next clock update.
  const atUpdate = (app.lastUpdateTime() - period.sunrise) / (period.sunset - period.sunrise);
  const now = (app.now() - period.sunrise) / (period.sunset - period.sunrise);
  const actualX = parseFloat(app.ids['period-marker'].style.left);
  const actualY = parseFloat(app.ids['period-marker'].style.top);
  const progress = (actualX * 7 - start) / width;
  assert.ok(progress >= atUpdate - 1e-6 && progress <= now + 1e-6,
    `marker progress ${progress} must lie between update ${atUpdate} and now ${now}`);
  near(actualY, (118 - 356 * progress * (1 - progress)) / 1.5, 'marker lies on rendered arc');
}

function waitForIntermediate(app, from, to) {
  for (let i = 0; i < 1000 && app.pending(); i++) {
    app.tick();
    const width = geometry(app).width;
    if (width > Math.min(from, to) + 1e-5 && width < Math.max(from, to) - 1e-5) return width;
  }
  assert.fail('expected a rendered intermediate width before the animation settled');
}

test('initial and post-loading arcs snap to their widths without scheduling animation', () => {
  for (const withLoading of [false, true]) {
    const app = setup();
    if (withLoading) app.update(null);
    app.update(day(4));
    near(geometry(app).width, targetWidth(4), 'initial width');
    assert.equal(app.pending(), 0);
    assert.equal(app.fill.hidden, false);
    assert.equal(app.curve.hidden, false);
    assert.equal(app.ids['period-start-point'].hidden, false);
    assert.equal(app.ids['period-end-point'].hidden, false);
    checkMarker(app, day(4));
  }
});

test('entering preview and scrubbing between dates update the whole arc immediately', () => {
  const app = setup();
  app.update(day(8));
  checkMarker(app, day(8));
  const requests = app.requests();
  for (const hours of [4, 12, 2, 18, 22, 6, 6]) {
    app.update(day(hours), null, null, true);
    near(geometry(app).width, targetWidth(hours), `preview ${hours}h snaps`);
    assert.equal(app.ids.duration.textContent, `${hours}h00m`);
    assert.equal(app.ids['period-marker'].hidden, true);
    assert.equal(app.pending(), 0, 'preview must not queue an animation');
    assert.equal(app.requests(), requests, 'preview never requests a frame');
    app.tick(5); // Scrubbing faster than a display frame must still update immediately.
  }
});

test('chart pointer scrubbing snaps each date and pointer leave starts the return', () => {
  const app = setup();
  const current = day(8);
  const days = [
    { ...day(4), date: '2025-06-20' }, current,
    { ...day(12), date: '2025-06-22' }
  ];
  const hit = app.renderChart(days, current);
  near(geometry(app).width, targetWidth(8), 'chart initially shows current');
  hit.dispatch('pointermove', { clientX: 65, pointerType: 'mouse' });
  near(geometry(app).width, targetWidth(4), 'first pointer preview snaps');
  hit.dispatch('pointermove', { clientX: 688, pointerType: 'mouse' });
  near(geometry(app).width, targetWidth(12), 'second pointer preview snaps');
  assert.equal(app.ids['period-marker'].hidden, true);
  assert.equal(app.pending(), 0);
  hit.dispatch('pointerleave', { pointerType: 'mouse' });
  near(geometry(app).width, targetWidth(12), 'pointer leave starts at preview width');
  assert.ok(app.pending() > 0, 'pointer leave schedules return');
  waitForIntermediate(app, targetWidth(12), targetWidth(8));
  hit.dispatch('pointermove', { clientX: 65, pointerType: 'mouse' });
  near(geometry(app).width, targetWidth(4), 'pointer re-entry interrupts return immediately');
  assert.equal(app.pending(), 0);
  assert.equal(app.ids['period-marker'].hidden, true);
  app.tick(1000);
  near(geometry(app).width, targetWidth(4), 'interrupted return stays cancelled');
  hit.dispatch('pointerleave', { pointerType: 'mouse' });
  app.finish();
  near(geometry(app).width, targetWidth(8), 'second pointer leave returns to current');
  checkMarker(app, current);
});

test('chart keyboard exploration snaps and blur animates back to current', () => {
  const app = setup();
  const current = day(8);
  const days = [
    { ...day(4), date: '2025-06-20' }, current,
    { ...day(12), date: '2025-06-22' }
  ];
  const hit = app.renderChart(days, current);
  hit.dispatch('focus');
  assert.equal(app.ids['period-marker'].hidden, true, 'focus previews even the current date');
  let prevented = 0;
  hit.dispatch('keydown', { key: 'ArrowLeft', preventDefault() { prevented++; } });
  near(geometry(app).width, targetWidth(4), 'keyboard preview snaps');
  hit.dispatch('keydown', { key: 'End', preventDefault() { prevented++; } });
  near(geometry(app).width, targetWidth(12), 'keyboard jump snaps');
  assert.equal(prevented, 2);
  assert.equal(app.pending(), 0);
  hit.dispatch('blur');
  near(geometry(app).width, targetWidth(12), 'blur starts at preview width');
  assert.ok(app.pending() > 0, 'blur schedules return');
  waitForIntermediate(app, targetWidth(12), targetWidth(8));
  app.finish();
  near(geometry(app).width, targetWidth(8), 'blur returns to current');
  checkMarker(app, current);
});

test('returning from preview animates to current daylight in about 180 ms', () => {
  for (const [previewHours, currentHours] of [[4, 12], [16, 3]]) {
    const app = setup();
    const current = day(currentHours, 0.75);
    app.update(day(previewHours), null, null, true);
    app.update(current);
    near(geometry(app).width, targetWidth(previewHours), 'return starts at the preview width');
    assert.ok(app.pending() > 0, 'return schedules a frame');
    assert.equal(app.ids.duration.textContent, `${currentHours}h00m`);
    checkMarker(app, current);
    app.tick(16);
    app.tick(74);
    const middle = geometry(app).width;
    assert.ok(middle > Math.min(targetWidth(previewHours), targetWidth(currentHours)) &&
      middle < Math.max(targetWidth(previewHours), targetWidth(currentHours)), 'midpoint remains in transition');
    checkMarker(app, current);
    app.tick(60);
    assert.ok(app.pending() > 0, 'return is still in progress at 150 ms');
    app.tick(58);
    near(geometry(app).width, targetWidth(currentHours), 'return reaches current width by 208 ms');
    assert.equal(app.pending(), 0);
    checkMarker(app, current);
  }
});

test('returning from preview animates to the current night interval and marker', () => {
  const base = epoch / 1000;
  const cases = [
    {
      current: { date: '2025-06-21', sunrise: base + 10 * hour, sunset: base + 20 * hour, duration: 10 * hour },
      previous: { sunset: base - 2 * hour }, next: null,
      night: { sunrise: base - 2 * hour, sunset: base + 10 * hour }
    },
    {
      current: { date: '2025-06-21', sunrise: base - 12 * hour, sunset: base - 2 * hour, duration: 10 * hour },
      previous: null, next: { sunrise: base + 10 * hour },
      night: { sunrise: base - 2 * hour, sunset: base + 10 * hour }
    }
  ];
  for (const { current, previous, next, night } of cases) {
    const app = setup();
    app.update(day(4), null, null, true);
    app.update(current, previous, next);
    assert.match(app.ids.duration.getAttribute('aria-label'), /^nighttime:/);
    near(geometry(app).width, targetWidth(4), 'night return starts at preview width');
    checkMarker(app, night);
    waitForIntermediate(app, targetWidth(4), targetWidth(12));
    checkMarker(app, night);
    app.finish();
    near(geometry(app).width, targetWidth(12), 'night return reaches night width');
    checkMarker(app, night);
  }
});

test('ordinary current-day and current-night changes snap rather than animate', () => {
  const app = setup();
  app.update(day(4));
  app.update(day(12));
  near(geometry(app).width, targetWidth(12), 'current daylight change snaps');
  assert.equal(app.pending(), 0);
  checkMarker(app, day(12));
  const base = epoch / 1000;
  const previous = { sunset: base - 2 * hour };
  const nightDay = (hoursUntilSunrise) => ({
    date: '2025-06-21', sunrise: base + hoursUntilSunrise * hour,
    sunset: base + (hoursUntilSunrise + 10) * hour, duration: 10 * hour
  });
  app.update(nightDay(6), previous);
  near(geometry(app).width, targetWidth(8), 'current night snaps');
  app.update(nightDay(10), previous);
  near(geometry(app).width, targetWidth(12), 'current night change snaps');
  assert.equal(app.pending(), 0);
  checkMarker(app, { sunrise: previous.sunset, sunset: nightDay(10).sunrise });
});

test('continuous polar periods show a full arc without endpoints or a marker', () => {
  for (const duration of [0, 86400]) {
    const app = setup();
    app.update({ date: '2025-06-21', sunrise: null, sunset: null, duration });
    near(geometry(app).width, 440, '24-hour period is capped at 18 hours');
    assert.equal(app.curve.hidden, false);
    assert.equal(app.ids['period-start-point'].hidden, true);
    assert.equal(app.ids['period-end-point'].hidden, true);
    assert.equal(app.ids['period-marker'].hidden, true);
    assert.equal(app.pending(), 0);
  }
});

test('a polar-night preview has no daylight arc and a later valid preview snaps', () => {
  const app = setup();
  app.update(day(4));
  app.update({ date: '2025-12-21', sunrise: null, sunset: null, duration: 0 }, null, null, true);
  assert.equal(app.ids.duration.textContent, '0h00m');
  assert.equal(app.ids['period-state'].textContent.includes('polar night'), true);
  assert.equal(app.curve.hidden, true);
  assert.equal(app.ids['period-marker'].hidden, true);
  assert.equal(app.ids['period-start-point'].hidden, true);
  assert.equal(app.pending(), 0);
  app.update(day(8), null, null, true);
  near(geometry(app).width, targetWidth(8), 'valid preview after polar night snaps');
  assert.equal(app.pending(), 0);
});

test('transitions to and from continuous periods snap instead of inventing endpoints', () => {
  const app = setup();
  const polarDay = { date: '2025-06-21', sunrise: null, sunset: null, duration: 86400 };
  app.update(day(4), null, null, true);
  app.update(day(12));
  waitForIntermediate(app, targetWidth(4), targetWidth(12));
  app.update(polarDay, null, null, true);
  near(geometry(app).width, 440, 'continuous period snaps to full width');
  assert.equal(app.ids['period-start-point'].hidden, true);
  assert.equal(app.ids['period-end-point'].hidden, true);
  assert.equal(app.pending(), 0);
  app.update(day(8));
  near(geometry(app).width, targetWidth(8), 'return with restored endpoints snaps to its width');
  assert.equal(app.ids['period-start-point'].hidden, false);
  assert.equal(app.pending(), 0);
  checkMarker(app, day(8));
});

test('re-entering preview interrupts a return and snaps, even at the old target', () => {
  for (const [previewHours, duringFrame] of [[4, false], [16, false], [2, true], [16, true]]) {
    const app = setup();
    app.update(day(4), null, null, true);
    app.update(day(16));
    if (duringFrame) waitForIntermediate(app, targetWidth(4), targetWidth(16));
    const cancellations = app.cancellations();
    app.update(day(previewHours), null, null, true);
    near(geometry(app).width, targetWidth(previewHours), 'interruption snaps to preview width');
    assert.equal(app.ids['period-marker'].hidden, true);
    assert.equal(app.pending(), 0);
    assert.ok(app.cancellations() > cancellations, 'in-flight return is cancelled');
    app.tick(1000);
    near(geometry(app).width, targetWidth(previewHours), 'cancelled return cannot overwrite preview');
    if (previewHours !== 16) {
      app.update(day(16));
      near(geometry(app).width, targetWidth(previewHours), 'next return starts from snapped preview');
      waitForIntermediate(app, targetWidth(previewHours), targetWidth(16));
      app.finish();
      near(geometry(app).width, targetWidth(16), 'next return reaches current width');
    }
  }
});

test('repeated clock updates do not restart or prolong the return transition', () => {
  const app = setup();
  const current = day(12, 0.75);
  app.update(day(4), null, null, true);
  app.update(current);
  waitForIntermediate(app, targetWidth(4), targetWidth(12));
  const before = geometry(app).width;
  const requests = app.requests(), cancellations = app.cancellations(), pending = app.pending();
  app.update(current);
  near(geometry(app).width, before, 'same target keeps current width');
  assert.equal(app.requests(), requests, 'clock update does not schedule a replacement');
  assert.equal(app.cancellations(), cancellations, 'clock update does not cancel the running frame');
  assert.equal(app.pending(), pending);
  checkMarker(app, current);
  // Clock updates on every frame must still finish on the original timeline.
  for (let i = 0; i < 12; i++) {
    app.tick(16);
    app.update(current);
    checkMarker(app, current);
  }
  assert.equal(app.pending(), 0, 'return settles within 208 ms despite updates');
  near(geometry(app).width, targetWidth(12), 'current target reaches destination');
});

test('same-width preview to current update reveals and updates the marker without animation', () => {
  const app = setup();
  const current = day(8, 0.75);
  app.update(day(8, 0.25), null, null, true);
  assert.equal(app.ids['period-marker'].hidden, true);
  const requests = app.requests();
  app.update(current);
  assert.equal(app.requests(), requests);
  assert.equal(app.pending(), 0);
  checkMarker(app, current);
  app.tick(1000);
  app.update(current);
  checkMarker(app, current);
});

test('no-arc states clear a running animation and the next arc snaps', () => {
  const noArcDays = [
    null,
    { date: '2025-06-21', duration: null, sunrise: epoch / 1000, sunset: null },
    { date: '2025-06-21', duration: 8 * hour, sunrise: epoch / 1000 + hour, sunset: epoch / 1000 - hour }
  ];
  for (const missing of noArcDays) {
    const app = setup();
    app.update(day(4), null, null, true);
    app.update(day(12));
    waitForIntermediate(app, targetWidth(4), targetWidth(12));
    app.update(missing, null, null, true);
    assert.equal(app.fill.hidden, true);
    assert.equal(app.curve.hidden, true);
    assert.equal(app.ids['period-marker'].hidden, true);
    assert.equal(app.ids['period-start-point'].hidden, true);
    assert.equal(app.ids['period-end-point'].hidden, true);
    assert.equal(app.pending(), 0, 'pending animation is cleared');
    app.tick(10000);
    assert.equal(app.curve.hidden, true, 'old frame cannot reveal an unavailable arc');
    app.update(day(8), null, null, true);
    near(geometry(app).width, targetWidth(8), 'first new arc snaps');
    assert.equal(app.pending(), 0);
  }
});

test('reduced motion snaps updates, including when enabled during an animation', () => {
  const app = setup({ reduced: true });
  app.update(day(4), null, null, true);
  app.update(day(12));
  assert.ok(app.mediaQueries.includes('(prefers-reduced-motion: reduce)'));
  near(geometry(app).width, targetWidth(12), 'reduced motion snaps return');
  assert.equal(app.pending(), 0);
  assert.equal(app.requests(), 0, 'reduced-motion return never requests a frame');
  checkMarker(app, day(12));

  app.setReduced(false);
  app.update(day(4), null, null, true);
  app.update(day(12));
  waitForIntermediate(app, targetWidth(4), targetWidth(12));
  app.setReduced(true);
  near(geometry(app).width, targetWidth(12), 'enabling reduced motion finishes the active return');
  assert.equal(app.pending(), 0, 'enabling reduced motion cancels the pending frame');
  checkMarker(app, day(12));
  app.update(day(8), null, null, true);
  app.update(day(4));
  near(geometry(app).width, targetWidth(4), 'next return snaps after preference change');
  assert.equal(app.pending(), 0);
  app.tick(10000);
  near(geometry(app).width, targetWidth(4), 'cancelled animation cannot overwrite reduced-motion result');
});

// Keep all arc widths identical so pending frames belong only to the chart line.
function lineChart(options) {
  const app = setup(options);
  const current = day(8);
  const days = ['19', '20', '21', '22', '23'].map((date) => ({ ...current, date: `2025-06-${date}` }));
  const hit = app.renderChart(days, current);
  const cursor = app.ids.chart.children.find((child) => child.getAttribute('class') === 'hover-line');
  assert.ok(cursor, 'chart has a hover line');
  return { app, hit, cursor };
}

const chartXs = [12, 181, 350, 519, 688];
function pointerAt(hit, index) {
  hit.dispatch('pointermove', { clientX: chartXs[index], pointerType: 'mouse' });
}
function assertLine(cursor, x, visibility) {
  near(Number(cursor.getAttribute('x1')), x, 'hover line x1');
  near(Number(cursor.getAttribute('x2')), x, 'hover line x2');
  assert.equal(cursor.getAttribute('visibility'), visibility, 'hover line visibility');
}
function lineX(cursor) {
  const x = Number(cursor.getAttribute('x1'));
  near(Number(cursor.getAttribute('x2')), x, 'line stays vertical');
  return x;
}
function key(hit, name) {
  let prevented = false;
  hit.dispatch('keydown', { key: name, preventDefault() { prevented = true; } });
  assert.ok(prevented, `${name} is handled`);
}

test('year chart keeps grid lines without time axis labels', () => {
  const { app, hit } = lineChart();
  const labels = app.ids.chart.children.filter((child) => child.getAttribute('class') === 'axis-label time-axis-label');
  const lines = app.ids.chart.children.filter((child) => child.getAttribute('class') === 'grid-line');
  assert.equal(labels.length, 0);
  assert.equal(lines.length, 9);
  assert.match(hit.getAttribute('aria-valuetext'), /^Jun 21: .*8 hours 0 minutes daylight/);
});

test('selected date shares the month axis without overlapping month labels', () => {
  const app = setup();
  const days = ['01', '02', '03', '04', '05'].map((month) => ({ ...day(8), date: `2025-${month}-01` }));
  const hit = app.renderChart(days, days[2]);
  const months = app.ids.chart.children.filter((child) => child.getAttribute('class') === 'axis-label month-axis-label');
  const marker = app.ids.chart.children.find((child) => child.getAttribute('aria-hidden') === 'true' && child.children.length > 0);
  const selectedDate = () => marker.children.find((child) => child.getAttribute('class') === 'point-label chart-date');
  assert.equal(selectedDate().textContent, 'Mar 1');
  assert.equal(selectedDate().getAttribute('y'), months[2].getAttribute('y'));
  assert.equal(months[2].classList.contains('is-obscured'), true);
  assert.equal(months[2].getAttribute('aria-hidden'), 'true');
  pointerAt(hit, 0);
  assert.equal(selectedDate().textContent, 'Jan 1');
  assert.equal(months[0].classList.contains('is-obscured'), true);
  assert.equal(months[2].classList.contains('is-obscured'), false);
  assert.equal(months[2].getAttribute('aria-hidden'), null);
});

test('year-chart hover line follows every pointer selection immediately', () => {
  const { app, hit, cursor } = lineChart();
  assertLine(cursor, chartXs[2], 'hidden');
  const requests = app.requests();
  for (const index of [0, 4, 1, 2, 3, 3, 0]) {
    pointerAt(hit, index);
    assertLine(cursor, chartXs[index], index === 2 ? 'hidden' : 'visible');
    assert.equal(hit.getAttribute('aria-valuenow'), String(index + 1));
    assert.equal(app.pending(), 0, 'scrubbing does not schedule a frame');
  }
  hit.dispatch('pointerdown', { clientX: chartXs[4], pointerType: 'touch' });
  assertLine(cursor, chartXs[4], 'visible');
  hit.dispatch('pointerleave', { pointerType: 'touch' });
  assertLine(cursor, chartXs[4], 'visible');
  assert.equal(app.pending(), 0, 'touch leave preserves the selection');
  assert.equal(app.requests(), requests, 'scrubbing never animates the line');
});

test('mouse leave and keyboard blur ease the hover line from the selected date to today', () => {
  for (const source of ['mouse', 'keyboard']) {
    for (const index of [0, 4]) {
      const { app, hit, cursor } = lineChart();
      if (source === 'mouse') pointerAt(hit, index);
      else { hit.dispatch('focus'); key(hit, index === 0 ? 'Home' : 'End'); }
      assertLine(cursor, chartXs[index], 'visible');
      if (source === 'mouse') hit.dispatch('pointerleave', { pointerType: 'mouse' });
      else hit.dispatch('blur');
      assert.equal(hit.getAttribute('aria-valuenow'), '3', 'selection resets immediately');
      assertLine(cursor, chartXs[index], 'visible');
      assert.ok(app.pending() > 0, 'return schedules a frame');
      app.tick(0); // Give implementations that start on their first frame the same clock origin.
      app.tick(45);
      const x45 = lineX(cursor);
      app.tick(45);
      const x90 = lineX(cursor);
      app.tick(60);
      const x150 = lineX(cursor);
      const fraction = (x) => (x - chartXs[index]) / (chartXs[2] - chartXs[index]);
      assert.ok(fraction(x45) > 0 && fraction(x45) < fraction(x90), 'line moves toward today');
      assert.ok(fraction(x90) < fraction(x150) && fraction(x150) < 1, 'line continues toward today');
      assert.ok(Math.abs(fraction(x45) - 0.25) > 0.02 || Math.abs(fraction(x150) - 150 / 180) > 0.02,
        'return uses easing rather than linear interpolation');
      assert.equal(cursor.getAttribute('visibility'), 'visible', 'line remains visible during return');
      app.tick(58);
      assertLine(cursor, chartXs[2], 'hidden');
      assert.equal(app.pending(), 0, 'return completes by 208 ms');
    }
  }
});

test('leaving or blurring while already on today does not animate the hover line', () => {
  for (const source of ['mouse', 'keyboard']) {
    const { app, hit, cursor } = lineChart();
    if (source === 'mouse') pointerAt(hit, 2);
    else hit.dispatch('focus');
    const requests = app.requests();
    if (source === 'mouse') hit.dispatch('pointerleave', { pointerType: 'mouse' });
    else hit.dispatch('blur');
    assertLine(cursor, chartXs[2], 'hidden');
    assert.equal(app.pending(), 0);
    assert.equal(app.requests(), requests, 'no animation is scheduled for today');
  }
});

test('scrubbing interrupts a returning hover line and tracks immediately', () => {
  for (const advance of [false, true]) {
    for (const index of [4, 2]) {
      const { app, hit, cursor } = lineChart();
      pointerAt(hit, 0);
      hit.dispatch('pointerleave', { pointerType: 'mouse' });
      assert.ok(app.pending() > 0);
      if (advance) { app.tick(0); app.tick(60); }
      const cancellations = app.cancellations();
      pointerAt(hit, index);
      assertLine(cursor, chartXs[index], index === 2 ? 'hidden' : 'visible');
      assert.equal(app.pending(), 0, 'scrubbing cancels the return');
      assert.ok(app.cancellations() > cancellations);
      app.tick(1000);
      assertLine(cursor, chartXs[index], index === 2 ? 'hidden' : 'visible');
      pointerAt(hit, 1);
      assertLine(cursor, chartXs[1], 'visible');
      hit.dispatch('pointerleave', { pointerType: 'mouse' });
      app.tick(0);
      app.tick(208);
      assertLine(cursor, chartXs[2], 'hidden');
      assert.equal(app.pending(), 0);
    }
  }
});

test('keyboard selection interrupts a returning hover line', () => {
  const { app, hit, cursor } = lineChart();
  pointerAt(hit, 0);
  hit.dispatch('pointerleave', { pointerType: 'mouse' });
  assert.ok(app.pending() > 0);
  app.tick(0);
  app.tick(60);
  hit.dispatch('focus');
  key(hit, 'End');
  assertLine(cursor, chartXs[4], 'visible');
  assert.equal(app.pending(), 0);
  app.tick(1000);
  assertLine(cursor, chartXs[4], 'visible');
});

test('reduced motion snaps the hover line to today and hides it, including mid-return', () => {
  for (const phase of ['initial', 'before-frame', 'mid-return']) {
    const { app, hit, cursor } = lineChart({ reduced: phase === 'initial' });
    pointerAt(hit, 0);
    const requests = app.requests();
    hit.dispatch('pointerleave', { pointerType: 'mouse' });
    if (phase !== 'initial') {
      assert.ok(app.pending() > 0);
      if (phase === 'mid-return') { app.tick(0); app.tick(60); }
      app.setReduced(true);
    } else assert.equal(app.requests(), requests, 'reduced motion does not request a frame');
    assertLine(cursor, chartXs[2], 'hidden');
    assert.equal(app.pending(), 0, 'reduced motion cancels any pending return');
    app.tick(1000);
    assertLine(cursor, chartXs[2], 'hidden');
  }
});

test('chart redraw cancels the old hover-line animation', () => {
  for (const advance of [false, true]) {
    const { app, hit, cursor } = lineChart();
    pointerAt(hit, 0);
    hit.dispatch('pointerleave', { pointerType: 'mouse' });
    assert.ok(app.pending() > 0);
    if (advance) { app.tick(0); app.tick(60); }
    const cancellations = app.cancellations();
    app.redrawChart();
    const oldX = lineX(cursor), oldVisibility = cursor.getAttribute('visibility');
    const newCursor = app.ids.chart.children.find((child) => child.getAttribute('class') === 'hover-line');
    assert.ok(newCursor && newCursor !== cursor, 'redraw replaces the line');
    assertLine(newCursor, chartXs[2], 'hidden');
    assert.equal(app.pending(), 0, 'redraw cancels the old frame');
    assert.ok(app.cancellations() > cancellations);
    app.tick(1000);
    assertLine(cursor, oldX, oldVisibility);
    assertLine(newCursor, chartXs[2], 'hidden');
  }
});
