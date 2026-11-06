'use strict';

const DEFAULT_LOCATION = { name: 'Victoria, British Columbia, Canada', lat: 48.4284, lon: -123.3656, tz: 'America/Vancouver' };
const $ = (id) => document.getElementById(id);
const input = $('location-input');
const clearLocation = $('location-clear');
const locationControl = document.querySelector('.location-control');
const dropdown = $('location-dropdown');
const chart = $('chart');
const SVG_NS = 'http://www.w3.org/2000/svg';
let currentLocation = DEFAULT_LOCATION;
let results = [];
let activeIndex = -1;
let debounce;
let searchVersion = 0;
let loadVersion = 0;
let loadController;
let clockTimer;
let resetChartSelection;
let redrawChart;
let chartPreview;
let updateCurrentVisual;
let outsidePointer;
let chartReturn;
let chartNight = false;
let chartInteractive = !window.matchMedia('(hover: none) and (pointer: coarse)').matches;

function updateChartDescription() {
  const chartText = chartNight
    ? 'The upper line shows sunset and the lower line shows the following sunrise, from noon to noon. The shaded area shows the night beginning on each date.'
    : 'The upper line shows sunrise and the lower line shows sunset. The shaded area shows daylight.';
  const interactionText = chartInteractive
    ? 'Focus the chart and use the left and right arrow keys to explore dates.'
    : 'Chart exploration is off. Use the explore toggle to enable it.';
  $('chart-description').textContent = `${chartText} The dashed line marks today. ${interactionText}`;
}

function updateChartToggle() {
  $('chart-toggle').setAttribute('aria-pressed', String(chartInteractive));
  $('chart-wrap').classList.toggle('is-interactive', chartInteractive);
  updateChartDescription();
}

updateChartToggle();
$('chart-toggle').addEventListener('click', () => {
  if (chartInteractive) resetChartSelection?.();
  chartInteractive = !chartInteractive;
  updateChartToggle();
  redrawChart?.();
});
const fullscreenLayout = window.matchMedia('(max-width:600px), (max-height:500px) and (pointer:coarse)');
new ResizeObserver(() => redrawChart?.()).observe($('chart-wrap'));

document.addEventListener('pointerdown', (event) => {
  if (event.isPrimary && !chart.contains(event.target)) {
    outsidePointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
  }
});
document.addEventListener('pointerup', (event) => {
  if (outsidePointer?.id !== event.pointerId) return;
  if (Math.hypot(event.clientX - outsidePointer.x, event.clientY - outsidePointer.y) < 10) resetChartSelection?.();
  outsidePointer = undefined;
});
document.addEventListener('pointercancel', (event) => {
  if (outsidePointer?.id === event.pointerId) outsidePointer = undefined;
});

function validLocation(value) {
  if (!Number.isFinite(value.lat) || Math.abs(value.lat) > 90 || !Number.isFinite(value.lon) || Math.abs(value.lon) > 180 || !value.tz) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value.tz }); return true; } catch { return false; }
}

function locationFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const candidate = {
    lat: params.has('lat') && params.get('lat').trim() ? Number(params.get('lat')) : NaN,
    lon: params.has('lon') && params.get('lon').trim() ? Number(params.get('lon')) : NaN,
    tz: params.get('tz'), name: params.get('n') || 'Selected location'
  };
  return validLocation(candidate) ? candidate : { ...DEFAULT_LOCATION };
}

function todayIn(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatDate(date, options) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(new Date(`${date}T12:00:00Z`));
}

function formatTime(timestamp, timeZone) {
  if (!Number.isFinite(timestamp)) return '—';
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hour12: true }).format(timestamp * 1000).replace(/\s/g, '').toUpperCase();
}

function formatCountdown(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor(totalSeconds % 3600 / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function hasSunEvents(day) {
  return day && day.duration > 0 && day.duration < 86400 && Number.isFinite(day.sunrise) && Number.isFinite(day.sunset);
}

// A partial polar day can have just one event; its position still determines
// whether the sun is currently up. A missing observation leaves the mode alone.
function sunIsUp(day, now = Date.now() / 1000) {
  if (!day) return null;
  const sunrise = Number.isFinite(day.sunrise) ? day.sunrise : null;
  const sunset = Number.isFinite(day.sunset) ? day.sunset : null;
  if (sunrise !== null && sunset !== null) {
    return sunrise < sunset ? now >= sunrise && now < sunset : now < sunset || now >= sunrise;
  }
  if (sunrise !== null) return now >= sunrise;
  if (sunset !== null) return now < sunset;
  if (day.duration === 0) return false;
  if (day.duration === 86400) return true;
  return null;
}

function setDisplayMode(day, locationName) {
  const isUp = sunIsUp(day);
  if (isUp === null) return;
  const night = !isUp;
  const changed = chartNight !== night;
  chartNight = night;
  $('app-title').textContent = night ? 'nighttime hours' : 'daylight hours';
  $('chart-title').textContent = night ? 'the year at night' : 'the year in daylight';
  updateChartDescription();
  document.title = `${night ? 'nighttime' : 'daylight'} - ${locationName.toLowerCase()}`;
  if (changed) redrawChart?.();
}

// Nights are keyed by the date of sunset. A missing next sunrise remains
// unavailable rather than being estimated from a 24-hour calendar day.
function nightFor(days, index) {
  const start = days[index]?.sunset;
  if (!Number.isFinite(start)) return { start: null, end: null, duration: null };
  for (let i = index; i < days.length; i++) {
    const events = [
      { time: days[i].sunrise, type: 'sunrise' },
      ...(i === index ? [] : [{ time: days[i].sunset, type: 'sunset' }])
    ].filter((event) => Number.isFinite(event.time) && event.time > start).sort((a, b) => a.time - b.time);
    if (events.length) {
      const end = events[0].type === 'sunrise' ? events[0].time : null;
      return { start, end, duration: end === null ? null : end - start };
    }
  }
  return { start, end: null, duration: null };
}

function updateHeading(today, tomorrow) {
  const heading = $('today-heading');
  const now = Date.now();
  function showCountdown(type, time) {
    const countdown = document.createElement('span');
    countdown.className = 'countdown';
    countdown.textContent = formatCountdown(time * 1000 - now);
    heading.replaceChildren(`${type} is in `, countdown);
  }
  // Near the polar circles, only one event may occur, or sunset may precede
  // sunrise within a local calendar day. Use the actual event order there.
  if (today.duration === null || tomorrow.duration === null || (hasSunEvents(today) && today.sunrise > today.sunset)) {
    const events = [today, tomorrow].flatMap((day) => hasSunEvents(day) || day.duration === null
      ? ['sunrise', 'sunset'].filter((type) => Number.isFinite(day[type]) && day[type] * 1000 > now).map((type) => ({ type, time: day[type] })) : []);
    events.sort((a, b) => a.time - b.time);
    if (events.length) showCountdown(events[0].type, events[0].time);
    else heading.textContent = 'next sunrise or sunset unavailable';
  } else if (!hasSunEvents(today)) {
    heading.textContent = today.duration <= 0 ? 'the sun won’t rise today' : 'the sun won’t set today';
  } else if (now < today.sunrise * 1000) {
    showCountdown('sunrise', today.sunrise);
  } else if (now < today.sunset * 1000) {
    showCountdown('sunset', today.sunset);
  } else if (hasSunEvents(tomorrow)) {
    showCountdown('sunrise', tomorrow.sunrise);
  } else {
    heading.textContent = 'the sun won’t rise tomorrow';
  }
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const minutes = Math.round(seconds / 60);
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

function spokenDuration(value) {
  const match = /^([+-]?)(?:(\d+)h)?(\d+)m$/.exec(value);
  if (!match) return value;
  const sign = match[1] === '-' ? 'minus ' : match[1] === '+' ? 'plus ' : '';
  const hours = match[2] === undefined ? '' : `${Number(match[2])} hours `;
  return `${sign}${hours}${Number(match[3])} minutes`;
}

// Animate one width so the SVG and HTML overlays always share the same geometry.
const periodVisual = document.querySelector('.period-visual');
const periodFill = document.querySelector('.period-fill');
const periodCurve = document.querySelector('.period-curve');
const periodMarker = $('period-marker');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const RETURN_DURATION = 180;
const easeOutCubic = (progress) => 1 - (1 - progress) ** 3;
let periodWidth = null, periodTargetWidth = null, periodFrame, periodHasEndpoints, periodIsPreview;
let periodStart, periodEnd, periodVisualWidth, periodDurationWidth;

function drawPeriodArc(width) {
  periodWidth = width;
  const startX = 350 - width / 2, endX = 350 + width / 2;
  const path = `M${startX} 118 Q350 -60 ${endX} 118`;
  periodFill.setAttribute('d', `${path} Z`);
  periodCurve.setAttribute('d', path);
  periodVisual.style.setProperty('--period-start-x', `${startX / 7}%`);
  periodVisual.style.setProperty('--period-end-x', `${endX / 7}%`);
  periodVisual.classList.toggle('is-narrow', width / 700 * periodVisualWidth < periodDurationWidth + 16);
  if (!periodMarker.hidden) {
    const progress = Math.max(0, Math.min(1, (Date.now() / 1000 - periodStart) / (periodEnd - periodStart)));
    // The quadratic Bézier has a linear x coordinate and a fixed height.
    periodMarker.style.left = `${(startX + width * progress) / 7}%`;
    periodMarker.style.top = `${(118 - 356 * progress * (1 - progress)) / 1.5}%`;
  }
}

function stopPeriodAnimation() {
  if (periodFrame !== undefined) cancelAnimationFrame(periodFrame);
  periodFrame = undefined;
}

function setPeriodWidth(width, hasEndpoints, preview) {
  const returningFromPreview = periodIsPreview && !preview;
  // Scrubbing follows the chart immediately; only the return to the current period animates.
  // Loading, unavailable events and continuous polar periods are distinct states.
  const snap = preview || periodWidth === null || periodHasEndpoints !== hasEndpoints || reducedMotion.matches ||
    (!returningFromPreview && width !== periodTargetWidth);
  periodHasEndpoints = hasEndpoints;
  periodIsPreview = preview;
  if (snap) {
    stopPeriodAnimation();
    periodTargetWidth = width;
    drawPeriodArc(width);
  } else if (width === periodTargetWidth) {
    // Clock ticks and pointer moves within the same date must not restart the animation.
    drawPeriodArc(periodWidth);
  } else {
    stopPeriodAnimation();
    periodTargetWidth = width;
    if (width === periodWidth) { drawPeriodArc(width); return; }
    const from = periodWidth, started = performance.now();
    const frame = (time) => {
      const progress = Math.min(1, Math.max(0, (time - started) / RETURN_DURATION));
      drawPeriodArc(from + (width - from) * easeOutCubic(progress));
      periodFrame = progress < 1 ? requestAnimationFrame(frame) : undefined;
    };
    periodFrame = requestAnimationFrame(frame);
    drawPeriodArc(periodWidth);
  }
}

function stopChartReturn() {
  if (!chartReturn) return;
  cancelAnimationFrame(chartReturn.frame);
  chartReturn.cursor.setAttribute('x1', chartReturn.target);
  chartReturn.cursor.setAttribute('x2', chartReturn.target);
  chartReturn.cursor.setAttribute('visibility', 'hidden');
  chartReturn = undefined;
}

reducedMotion.addEventListener('change', () => {
  if (!reducedMotion.matches) return;
  if (periodFrame !== undefined) {
    stopPeriodAnimation();
    drawPeriodArc(periodTargetWidth);
  }
  stopChartReturn();
});

// The arc shows elapsed time, not the sun's actual altitude.
function updateDaylightVisual(day, previousDay, nextDay, timeZone, preview = false, nightPreview = null) {
  const hasEvents = hasSunEvents(day);
  const isPartial = day?.duration === null;
  const hasDay = hasEvents && day.sunrise < day.sunset;
  const now = Date.now() / 1000;
  const isBeforeSunrise = hasDay && now < day.sunrise;
  const isNight = preview ? Boolean(nightPreview) : sunIsUp(day, now) === false;
  // Before sunrise, use the night currently ending; after sunset, use tonight.
  const nightStart = nightPreview ? nightPreview.start : isBeforeSunrise ? previousDay?.sunset : day?.sunset;
  const nightEnd = nightPreview ? nightPreview.end : isBeforeSunrise ? day?.sunrise : nextDay?.sunrise;
  const hasNight = (nightPreview || hasDay) && Number.isFinite(nightStart) && Number.isFinite(nightEnd) && nightEnd > nightStart;
  const start = isNight ? nightStart : day?.sunrise;
  const end = isNight ? nightEnd : day?.sunset;
  const hasPeriod = isNight ? hasNight : hasDay;
  // Continuous daylight or nighttime has a duration but no event endpoints.
  const hasContinuousPeriod = Boolean(!nightPreview && day && !hasEvents && !isPartial && (isNight || day.duration >= 86400));
  const hasArc = hasPeriod || hasContinuousPeriod;
  const marker = periodMarker;
  const visual = periodVisual;

  visual.classList.toggle('is-night', isNight);
  $('period-start-label').textContent = isNight ? 'sunset' : 'sunrise';
  $('period-end-label').textContent = isNight ? 'sunrise' : 'sunset';
  $('period-start-time').textContent = nightPreview ? (Number.isFinite(start) ? formatTime(start, timeZone) : 'No sunset') : !day ? '—' : isPartial ? (Number.isFinite(isNight ? day.sunset : day.sunrise) ? formatTime(isNight ? day.sunset : day.sunrise, timeZone) : isNight ? 'No sunset' : 'No sunrise') : !hasEvents ? (isNight ? 'No sunset' : 'No sunrise') : formatTime(start, timeZone);
  $('period-end-time').textContent = nightPreview ? (Number.isFinite(end) ? formatTime(end, timeZone) : '—') : !day ? '—' : isPartial ? (Number.isFinite(isNight ? day.sunrise : day.sunset) ? formatTime(isNight ? day.sunrise : day.sunset, timeZone) : isNight ? 'No sunrise' : 'No sunset') : !hasEvents ? (isNight ? 'No sunrise' : 'No sunset') : formatTime(end, timeZone);
  const duration = nightPreview ? formatDuration(nightPreview.duration) : !day || isPartial ? '—' : !hasEvents ? formatDuration(preview ? day.duration : 86400)
    : isNight ? (hasNight ? formatDuration(end - start) : '—') : formatDuration(day.duration);
  const canShowElapsed = !preview && Boolean(hasPeriod) && now >= start && now < end;
  const elapsed = canShowElapsed ? Math.floor((now - start) / (end - start) * 100) : null;
  $('duration').textContent = preview ? duration : canShowElapsed ? `${elapsed}%` : '—';
  $('duration').setAttribute('aria-label', `${isNight ? 'nighttime' : 'daylight'}: ${preview ? spokenDuration(duration) : canShowElapsed ? `${elapsed} percent elapsed` : 'elapsed percentage unavailable'}`);
  const state = nightPreview ? (hasNight ? '' : 'unavailable') : !day ? '' : isPartial ? 'one event today' : !hasEvents ? (day.duration <= 0 ? 'polar night' : 'midnight sun')
    : !hasDay ? 'events cross midnight' : isNight && !hasNight ? 'unavailable' : '';
  $('period-state').textContent = canShowElapsed ? 'elapsed' : [day && formatDate(day.date, { month: 'short', day: 'numeric' }), state].filter(Boolean).join(' · ');
  $('period-detail').textContent = isNight && hasNight ? `From sunset at ${formatTime(start, timeZone)} to ${nightPreview ? 'the following' : isBeforeSunrise ? 'today’s' : 'tomorrow’s'} sunrise at ${formatTime(end, timeZone)}.` : '';
  document.querySelectorAll('.period-arc').forEach((arc) => arc.toggleAttribute('hidden', !hasArc));
  $('period-start-point').hidden = $('period-end-point').hidden = !hasPeriod;
  marker.hidden = preview || !hasPeriod || now < start || now >= end;
  if (hasArc) {
    // The arc reaches its maximum width at 18 hours.
    const seconds = hasContinuousPeriod ? 86400 : isNight ? end - start : day.duration;
    const maxMinutes = 18 * 60;
    const width = 440 * Math.min(maxMinutes, Math.max(0, Math.round(seconds / 60))) / maxMinutes;
    periodStart = start;
    periodEnd = end;
    // Measure once per update, rather than forcing layout on every animation frame.
    periodVisualWidth = visual.clientWidth;
    periodDurationWidth = document.querySelector('.period-duration').offsetWidth;
    setPeriodWidth(width, hasPeriod, preview);
  } else {
    stopPeriodAnimation();
    periodWidth = periodTargetWidth = null;
    periodHasEndpoints = periodIsPreview = undefined;
    visual.classList.remove('is-narrow');
  }
}

function formatDurationDifference(seconds, todaySeconds) {
  const difference = Math.round(seconds / 60) - Math.round(todaySeconds / 60);
  const minutes = Math.abs(difference);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  const value = hours ? `${hours}h${String(remainder).padStart(2, '0')}m` : `${remainder}m`;
  return `${difference < 0 ? '-' : difference > 0 ? '+' : ''}${value}`;
}

function svgElement(tag, attributes, text) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  if (text !== undefined) element.textContent = text;
  return element;
}

function chartTimeBadge(parent, x, y, anchor, value, className, bounds) {
  const group = svgElement('g', { class: 'chart-time-badge' });
  const rect = svgElement('rect', { class: 'chart-time-background' });
  const text = svgElement('text', { x, y, 'text-anchor': anchor, 'dominant-baseline': 'central', class: className }, value);
  group.append(rect, text);
  parent.append(group);
  const fontSize = parseFloat(getComputedStyle(text).fontSize) || 13;
  const paddingX = fontSize * 0.3, paddingY = fontSize * 0.12;
  const textWidth = value.length * fontSize * 0.6;
  const offset = (anchor === 'middle' ? textWidth / 2 : anchor === 'end' ? textWidth : 0) + paddingX;
  if (bounds) {
    x = Math.max(bounds.left + offset, Math.min(bounds.right - (textWidth + paddingX * 2 - offset), x));
    text.setAttribute('x', x);
  }
  const left = x - offset;
  for (const [name, value] of Object.entries({ x: left, y: y - fontSize / 2 - paddingY, width: textWidth + paddingX * 2, height: fontSize + paddingY * 2, rx: fontSize * 0.32 })) rect.setAttribute(name, value);
}

function renderChart(days, today, timeZone, selection, followingDay = null) {
  stopChartReturn();
  const night = chartNight;
  const nightDays = followingDay ? [...days, followingDay] : days;
  const nights = night ? days.map((_, index) => nightFor(nightDays, index)) : null;
  const upperKey = night ? 'sunset' : 'sunrise';
  const lowerKey = night ? 'sunrise' : 'sunset';
  chart.replaceChildren();
  const width = 700, left = 12, right = 12;
  const bounds = $('chart-wrap').getBoundingClientRect();
  // Match the available aspect ratio without stretching text or strokes.
  const height = fullscreenLayout.matches && bounds.width && bounds.height ? width * bounds.height / bounds.width : 374;
  const top = Math.min(24, height / 4), bottom = Math.min(34, height / 4);
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const xFor = (index) => left + (index / (days.length - 1)) * plotWidth;
  const yFor = (hours) => top + (hours / 24) * plotHeight;
  const localTime = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const localHours = (timestamp) => {
    const parts = Object.fromEntries(localTime.formatToParts(timestamp * 1000).map(({ type, value }) => [type, value]));
    return Number(parts.hour) + Number(parts.minute) / 60 + Number(parts.second) / 3600;
  };
  const points = days.map((day, index) => {
    if (night) {
      const period = nights[index];
      const clock = (time) => Number.isFinite(time) ? (localHours(time) + 12) % 24 : null;
      const sunset = clock(period.start), sunrise = clock(period.end);
      // Noon-to-noon cannot represent a longer or midnight-wrapping interval.
      if (period.duration > 86400 || (sunset !== null && sunrise !== null && sunset > sunrise)) return null;
      return sunset !== null || sunrise !== null ? { x: xFor(index), sunset, sunrise } : null;
    }
    return hasSunEvents(day) || day.duration === null
      ? { x: xFor(index), sunrise: Number.isFinite(day.sunrise) ? localHours(day.sunrise) : null, sunset: Number.isFinite(day.sunset) ? localHours(day.sunset) : null }
      : null;
  });
  const todayIndex = days.findIndex((day) => day.date === today);
  // Before sunrise the ongoing night began yesterday, not tonight.
  const todayDay = days[todayIndex];
  const currentIndex = night && todayIndex > 0 && Number.isFinite(todayDay?.sunrise) &&
    Date.now() / 1000 < todayDay.sunrise && nights[todayIndex - 1].end === todayDay.sunrise
    ? todayIndex - 1 : todayIndex;
  chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
  chart.setAttribute('role', chartInteractive ? 'group' : 'img');

  for (let hours = 0; hours <= 24; hours += 3) {
    const y = yFor(hours);
    chart.append(svgElement('line', { x1: left, y1: y, x2: width - right, y2: y, class: 'grid-line' }));
  }
  const monthLabels = [];
  days.forEach((day, index) => {
    if (day.date.endsWith('-01')) {
      const x = xFor(index);
      chart.append(svgElement('line', { x1: x, y1: top, x2: x, y2: top + plotHeight, class: 'month-grid-line' }));
      chart.append(svgElement('line', { x1: x, y1: top + plotHeight, x2: x, y2: top + plotHeight + 5, class: 'month-tick' }));
      const text = svgElement('text', { x, y: height - 8, 'text-anchor': index === 0 ? 'start' : 'middle', class: 'axis-label month-axis-label' }, formatDate(day.date, { month: 'short' }).toLowerCase());
      chart.append(text);
      monthLabels.push(text);
    }
  });

  // Break paths at polar days and midnight wraps instead of inventing events.
  function segmentsFor(key) {
    const segments = [];
    let segment = [];
    points.forEach((point) => {
      if (!point || point[key] === null || (segment.length && Math.abs(point[key] - segment[segment.length - 1][key]) > 12)) {
        if (segment.length) segments.push(segment);
        segment = [];
      }
      if (point && point[key] !== null) segment.push(point);
    });
    if (segment.length) segments.push(segment);
    return segments;
  }
  // Shade only contiguous dates where both events occur in the same local day.
  let band = [];
  const drawBand = () => {
    if (band.length > 1) {
      const upper = band.map((point) => `${point.x},${yFor(point[upperKey])}`).join(' ');
      const lower = [...band].reverse().map((point) => `${point.x},${yFor(point[lowerKey])}`).join(' ');
      chart.append(svgElement('polygon', { points: `${upper} ${lower}`, class: night ? 'night-band' : 'daylight-band' }));
    }
    band = [];
  };
  points.forEach((point) => {
    const complete = point && point.sunrise !== null && point.sunset !== null;
    if (!complete || point[upperKey] > point[lowerKey] || (band.length && (Math.abs(point.sunrise - band[band.length - 1].sunrise) > 12 || Math.abs(point.sunset - band[band.length - 1].sunset) > 12))) drawBand();
    if (complete && point[upperKey] <= point[lowerKey]) band.push(point);
  });
  drawBand();
  for (const key of ['sunrise', 'sunset']) {
    for (const segment of segmentsFor(key)) {
      chart.append(svgElement('polyline', { points: segment.map((point) => `${point.x},${yFor(point[key])}`).join(' '), class: `sun-line ${key}-line` }));
    }
  }

  const todayX = xFor(todayIndex), currentX = xFor(currentIndex);
  chart.append(svgElement('line', { x1: todayX, y1: top, x2: todayX, y2: top + plotHeight, class: 'today-line' }));
  const cursor = svgElement('line', { y1: top, y2: top + plotHeight, class: 'hover-line', visibility: 'hidden' });
  const marker = svgElement('g', { 'aria-hidden': 'true' });
  chart.append(cursor, marker);
  const hitArea = svgElement('rect', {
    x: left, y: top, width: plotWidth, height: plotHeight, class: 'chart-hit',
    ...(chartInteractive ? { tabindex: '0', role: 'slider', 'aria-label': 'Explore dates', 'aria-valuemin': '1', 'aria-valuemax': days.length } : { 'aria-hidden': 'true' })
  });
  chart.append(hitArea);
  let selectedIndex = selection?.exploring ? selection.index : currentIndex;
  let exploring = selection?.exploring ?? false;
  let selectionSource = selection?.source;
  let restoringFocus = false;
  function selectDay(index) {
    stopChartReturn();
    selectedIndex = Math.max(0, Math.min(days.length - 1, index));
    const day = days[selectedIndex];
    chartPreview = exploring ? day : null;
    if (chartPreview) updateDaylightVisual(day, null, null, timeZone, true, night ? nights[selectedIndex] : null);
    else updateCurrentVisual?.();
    const label = formatDate(day.date, { month: 'short', day: 'numeric' });
    const period = night ? nights[selectedIndex] : null;
    const times = night
      ? `${Number.isFinite(period.start) ? `sunset ${formatTime(period.start, timeZone)}` : 'no sunset'}, ${Number.isFinite(period.end) ? `following sunrise ${formatTime(period.end, timeZone)}` : 'following sunrise unavailable'}`
      : hasSunEvents(day) || day.duration === null
        ? `${Number.isFinite(day.sunrise) ? `sunrise ${formatTime(day.sunrise, timeZone)}` : 'no sunrise'}, ${Number.isFinite(day.sunset) ? `sunset ${formatTime(day.sunset, timeZone)}` : 'no sunset'}`
        : (day.duration <= 0 ? 'no sunrise or sunset' : 'midnight sun');
    const seconds = night ? period.duration : day.duration;
    const currentSeconds = night ? nights[currentIndex].duration : days[currentIndex].duration;
    const duration = formatDuration(seconds);
    const difference = exploring && Number.isFinite(seconds) && Number.isFinite(currentSeconds) ? formatDurationDifference(seconds, currentSeconds) : '';
    $('chart-detail').textContent = label;
    if (chartInteractive) {
      hitArea.setAttribute('aria-valuenow', selectedIndex + 1);
      hitArea.setAttribute('aria-valuetext', `${label}: ${times}, ${spokenDuration(duration)} ${night ? 'nighttime' : 'daylight'}${difference ? `, ${spokenDuration(difference)} compared with the current ${night ? 'night' : 'day'}` : ''}`);
    }
    const x = xFor(selectedIndex);
    cursor.setAttribute('x1', x);
    cursor.setAttribute('x2', x);
    cursor.setAttribute('visibility', !exploring || selectedIndex === todayIndex ? 'hidden' : 'visible');

    marker.replaceChildren();
    const dateAnchor = x < left + 90 ? 'start' : x > width - right - 90 ? 'end' : 'middle';
    const dateLabel = svgElement('text', { x, y: height - 8, 'text-anchor': dateAnchor, class: 'point-label chart-date' }, label);
    marker.append(dateLabel);
    // Hide month labels that would overlap the selected date.
    function labelBounds(text) {
      const fontSize = parseFloat(getComputedStyle(text).fontSize) || 13;
      const textWidth = text.textContent.length * fontSize * 0.65;
      const anchor = text.getAttribute('text-anchor');
      const position = Number(text.getAttribute('x'));
      const start = position - (anchor === 'end' ? textWidth : anchor === 'middle' ? textWidth / 2 : 0);
      return { start, end: start + textWidth };
    }
    const dateBounds = labelBounds(dateLabel);
    for (const monthLabel of monthLabels) {
      const monthBounds = labelBounds(monthLabel);
      const obscured = monthBounds.end + 4 >= dateBounds.start && monthBounds.start - 4 <= dateBounds.end;
      monthLabel.classList.toggle('is-obscured', obscured);
      if (obscured) monthLabel.setAttribute('aria-hidden', 'true');
      else monthLabel.removeAttribute('aria-hidden');
    }
    const point = points[selectedIndex];
    const labelX = Math.max(left + 45, Math.min(width - right - 45, x));
    if (point) {
      for (const key of ['sunrise', 'sunset']) {
        if (point[key] === null) continue;
        const y = yFor(point[key]);
        const above = key === upperKey ? y - top >= 28 : top + plotHeight - y < 28;
        marker.append(svgElement('circle', { cx: x, cy: y, r: 4, class: `chart-point ${key}-point` }));
        const timestamp = night ? (key === 'sunset' ? period.start : period.end) : day[key];
        chartTimeBadge(marker, labelX, y + (above ? -17 : 17), 'middle', formatTime(timestamp, timeZone), 'point-label', { left, right: width - right });
      }
    }
    const completePoint = point && point.sunrise !== null && point.sunset !== null;
    const durationY = completePoint && point[upperKey] <= point[lowerKey]
      ? (yFor(point[upperKey]) + yFor(point[lowerKey])) / 2
      : top + plotHeight / 2;
    const narrowBand = completePoint && Math.abs(yFor(point.sunrise) - yFor(point.sunset)) < 28;
    const durationAnchor = narrowBand ? (x > left + plotWidth / 2 ? 'end' : 'start') : 'middle';
    const durationX = narrowBand ? x + (durationAnchor === 'end' ? -10 : 10) : labelX;
    const durationText = `${duration}${difference ? ` (${difference})` : ''}`;
    chartTimeBadge(marker, durationX, durationY, durationAnchor, durationText, 'point-label daylight-label', { left, right: width - right });
  }
  resetChartSelection = () => {
    if (!exploring) return;
    const from = xFor(selectedIndex);
    exploring = false;
    selectionSource = undefined;
    selectDay(currentIndex);
    if (from === currentX || reducedMotion.matches) return;
    cursor.setAttribute('x1', from);
    cursor.setAttribute('x2', from);
    cursor.setAttribute('visibility', 'visible');
    const started = performance.now();
    const frame = (time) => {
      const progress = Math.min(1, Math.max(0, (time - started) / RETURN_DURATION));
      const x = from + (currentX - from) * easeOutCubic(progress);
      cursor.setAttribute('x1', x);
      cursor.setAttribute('x2', x);
      if (progress < 1) chartReturn.frame = requestAnimationFrame(frame);
      else {
        cursor.setAttribute('visibility', 'hidden');
        chartReturn = undefined;
      }
    };
    chartReturn = { cursor, target: currentX, frame: requestAnimationFrame(frame) };
  };
  selectDay(selectedIndex);
  if (chartInteractive) {
    function selectPointerDay(event) {
      exploring = true;
      selectionSource = 'pointer';
      const bounds = chart.getBoundingClientRect();
      const x = (event.clientX - bounds.left) * width / bounds.width;
      selectDay(Math.round((x - left) / plotWidth * (days.length - 1)));
    }
    hitArea.addEventListener('pointermove', selectPointerDay);
    hitArea.addEventListener('pointerdown', selectPointerDay);
    hitArea.addEventListener('pointerleave', (event) => { if (event.pointerType === 'mouse' && selectionSource === 'pointer') resetChartSelection(); });
    hitArea.addEventListener('focus', () => {
      if (restoringFocus) return;
      if (!exploring) selectionSource = 'keyboard';
      exploring = true;
      selectDay(selectedIndex);
    });
    hitArea.addEventListener('blur', resetChartSelection);
    hitArea.addEventListener('keydown', (event) => {
      let next = selectedIndex;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next--;
      else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next++;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = days.length - 1;
      else return;
      event.preventDefault();
      exploring = true;
      selectionSource = 'keyboard';
      selectDay(next);
    });
  }
  if (chartInteractive && selection?.focused) {
    restoringFocus = true;
    hitArea.focus({ preventScroll: true });
    restoringFocus = false;
  }
  redrawChart = () => renderChart(days, today, timeZone, {
    index: selectedIndex, exploring, source: selectionSource, focused: document.activeElement === hitArea
  }, followingDay);
}

async function load() {
  stopChartReturn();
  resetChartSelection = undefined;
  redrawChart = undefined;
  chartPreview = null;
  const selected = { ...currentLocation };
  clearTimeout(clockTimer);
  const version = ++loadVersion;
  if (loadController) loadController.abort();
  loadController = new AbortController();
  const today = todayIn(selected.tz);
  const year = Number(today.slice(0, 4));
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  $('current-date').dateTime = today;
  $('current-date').textContent = formatDate(today, { weekday: 'long', month: 'long', day: 'numeric' });
  $('location-name').textContent = selected.name;
  chartNight = false;
  setDisplayMode({ sunrise: null, sunset: null, duration: 86400 }, selected.name);
  $('today-heading').textContent = 'loading daylight times…';
  updateCurrentVisual = () => updateDaylightVisual(null, null, null, selected.tz);
  updateCurrentVisual();
  $('chart-detail').textContent = 'hover or focus the chart for details';
  chart.setAttribute('hidden', '');
  $('chart-status').textContent = 'Loading daylight data…';
  $('chart-status').hidden = false;
  $('chart-wrap').setAttribute('aria-busy', 'true');
  $('retry').hidden = true;
  // Providers share the same normalized day contract. Add or reorder adapters here.
  const { openMeteo, sunriseSunset, localSolar, getDaysWithFallback } = DaylightProviders;
  let currentDay, forecastDays, annualDays, followingDay;
  function mergeForecast() {
    if (!forecastDays || !annualDays) return;
    for (const day of forecastDays) {
      const index = annualDays.findIndex((item) => item.date === day.date);
      if (index !== -1) annualDays[index] = day;
      else if (followingDay.date === day.date) Object.assign(followingDay, day);
    }
  }
  const forecast = getDaysWithFallback([openMeteo, sunriseSunset, localSolar], addDays(today, -1), addDays(today, 1), selected, loadController.signal, 'forecast')
    .then(({ days }) => {
      if (version !== loadVersion) return;
      forecastDays = days;
      const [previousDay, todayData, nextDay] = days;
      currentDay = todayData;
      updateCurrentVisual = () => updateDaylightVisual(currentDay, previousDay, nextDay, selected.tz);
      mergeForecast();
      scheduleClock(today, currentDay, nextDay, selected.tz);
      if (version !== loadVersion) return;
      if (annualDays) redrawChart?.();
    }).catch((error) => {
      if (version !== loadVersion) return;
      console.error('Could not load today’s daylight data:', error);
      $('today-heading').textContent = 'daylight times unavailable';
      updateCurrentVisual = () => {
        updateDaylightVisual(null, null, null, selected.tz);
        $('period-state').textContent = 'unavailable';
      };
      updateCurrentVisual();
      $('retry').hidden = false;
      scheduleClock(today, null, null, selected.tz);
    });
  // Include Jan 1 of the next year for Dec 31's night. On New Year's Day,
  // include the previous Dec 31 as well, for the night still in progress.
  const annualStart = today === start ? addDays(start, -1) : start;
  const annual = getDaysWithFallback([openMeteo, sunriseSunset, localSolar], annualStart, addDays(end, 1), selected, loadController.signal, 'annual')
    .then(({ days }) => {
      if (version !== loadVersion) return;
      annualDays = days.slice(0, -1);
      followingDay = days[days.length - 1];
      // Adjacent forecast events keep the current night's interval consistent.
      mergeForecast();
      renderChart(annualDays, today, selected.tz, undefined, followingDay);
      $('chart-status').hidden = true;
      chart.removeAttribute('hidden');
      $('chart-wrap').setAttribute('aria-busy', 'false');
    }).catch((error) => {
      if (version !== loadVersion) return;
      console.error('Could not load annual daylight data:', error);
      $('chart-status').textContent = 'Couldn’t load yearly daylight data. Check your connection and try again.';
      $('retry').hidden = false;
      $('chart-wrap').setAttribute('aria-busy', 'false');
    });
  await Promise.all([forecast, annual]);
}

function scheduleClock(date, currentDay, nextDay, timeZone) {
  clearTimeout(clockTimer);
  if (todayIn(timeZone) !== date) { load(); return; }
  if (currentDay) {
    setDisplayMode(currentDay, currentLocation.name);
    updateHeading(currentDay, nextDay);
    if (!chartPreview) updateCurrentVisual();
  }
  clockTimer = setTimeout(() => scheduleClock(date, currentDay, nextDay, timeZone), currentDay ? 1000 : 60000);
}

function closeDropdown() {
  dropdown.hidden = true;
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
}

function showResults(message) {
  dropdown.replaceChildren();
  if (message) {
    const empty = document.createElement('div');
    empty.className = 'location-empty';
    empty.textContent = message;
    dropdown.append(empty);
  } else {
    results.forEach((result, index) => {
      const option = document.createElement('div');
      option.className = `location-option${index === activeIndex ? ' active' : ''}`;
      option.id = `location-option-${index}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === activeIndex));
      option.textContent = result.name;
      option.addEventListener('mousedown', (event) => event.preventDefault());
      option.addEventListener('click', () => selectLocation(result));
      dropdown.append(option);
    });
  }
  dropdown.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  if (activeIndex >= 0 && results[activeIndex]) {
    input.setAttribute('aria-activedescendant', `location-option-${activeIndex}`);
    dropdown.children[activeIndex]?.scrollIntoView({ block: 'nearest' });
  } else input.removeAttribute('aria-activedescendant');
}

async function search(query, version) {
  try {
    const params = new URLSearchParams({ name: query, count: '8', language: 'en', format: 'json' });
    const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`);
    if (!response.ok) throw new Error(`Search returned ${response.status}`);
    const data = await response.json();
    if (version !== searchVersion) return;
    results = (data.results || []).map((item) => ({ name: [item.name, item.admin1, item.country].filter(Boolean).join(', '), lat: item.latitude, lon: item.longitude, tz: item.timezone || 'GMT' })).filter(validLocation);
    activeIndex = -1;
    showResults(results.length ? null : 'No locations found');
  } catch (error) {
    if (version !== searchVersion) return;
    results = [];
    activeIndex = -1;
    showResults('Couldn’t search locations. Try again.');
  }
}

function selectLocation(selected) {
  clearTimeout(debounce);
  searchVersion++;
  results = [];
  activeIndex = -1;
  currentLocation = selected;
  input.value = selected.name;
  closeDropdown();
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries({ lat: selected.lat, lon: selected.lon, tz: selected.tz, n: selected.name })) params.set(key, value);
  history.pushState(null, '', `${window.location.pathname}?${params}${window.location.hash}`);
  load();
}

input.addEventListener('input', () => {
  clearTimeout(debounce);
  const version = ++searchVersion;
  const query = input.value.trim();
  results = [];
  activeIndex = -1;
  if (query.length < 2) { closeDropdown(); return; }
  showResults('Searching…');
  debounce = setTimeout(() => search(query, version), 250);
});
input.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { clearTimeout(debounce); searchVersion++; closeDropdown(); input.value = currentLocation.name; return; }
  if (dropdown.hidden || !results.length) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    activeIndex = event.key === 'ArrowDown' ? Math.min(activeIndex + 1, results.length - 1) : Math.max(activeIndex - 1, 0);
    showResults();
  } else if (event.key === 'Enter' && activeIndex >= 0) {
    event.preventDefault();
    selectLocation(results[activeIndex]);
  }
});
clearLocation.addEventListener('pointerdown', (event) => event.preventDefault());
clearLocation.addEventListener('click', () => {
  input.value = '';
  input.focus();
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
document.addEventListener('click', (event) => { if (!event.target.closest('.location-control')) { clearTimeout(debounce); searchVersion++; closeDropdown(); input.value = currentLocation.name; } });
locationControl.addEventListener('focusout', (event) => {
  if (locationControl.contains(event.relatedTarget)) return;
  clearTimeout(debounce); searchVersion++; closeDropdown(); input.value = currentLocation.name;
});
$('retry').addEventListener('click', load);
window.addEventListener('popstate', () => { clearTimeout(debounce); searchVersion++; closeDropdown(); currentLocation = locationFromUrl(); input.value = currentLocation.name; load(); });
currentLocation = locationFromUrl();
input.value = currentLocation.name;
load();
