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
let outsidePointer;

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
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).format(timestamp * 1000).toLowerCase();
}

function formatCountdown(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  return [hours && `${hours}h`, (hours || minutes) && `${minutes}m`, `${seconds}s`].filter(Boolean).join(' ');
}

function hasSunEvents(day) {
  return day && day.duration > 0 && day.duration < 86400 && Number.isFinite(day.sunrise) && Number.isFinite(day.sunset);
}

function updateHeading(today, tomorrow) {
  const heading = $('today-heading');
  const now = Date.now();
  if (!hasSunEvents(today)) {
    heading.textContent = today.duration <= 0 ? 'the sun won’t rise today' : 'the sun won’t set today';
  } else if (now < today.sunrise * 1000) {
    heading.textContent = `sunrise is in ${formatCountdown(today.sunrise * 1000 - now)}`;
  } else if (now < today.sunset * 1000) {
    heading.textContent = `sunset is in ${formatCountdown(today.sunset * 1000 - now)}`;
  } else if (hasSunEvents(tomorrow)) {
    heading.textContent = `sunrise is in ${formatCountdown(tomorrow.sunrise * 1000 - now)}`;
  } else {
    heading.textContent = 'the sun won’t rise tomorrow';
  }
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const minutes = Math.round(seconds / 60);
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

// The arc shows elapsed time, not the sun's actual altitude.
function updateDaylightVisual(day, previousDay, nextDay, timeZone) {
  const hasEvents = hasSunEvents(day);
  const hasDay = hasEvents && day.sunrise < day.sunset;
  const now = Date.now() / 1000;
  const isDaylight = hasDay && now >= day.sunrise && now < day.sunset;
  const isBeforeSunrise = hasDay && now < day.sunrise;
  const isNight = Boolean((hasDay && !isDaylight) || (day && !hasEvents && day.duration <= 0));
  // Before sunrise, use the night currently ending; after sunset, use tonight.
  const nightStart = isBeforeSunrise ? previousDay?.sunset : day?.sunset;
  const nightEnd = isBeforeSunrise ? day?.sunrise : nextDay?.sunrise;
  const hasNight = hasDay && Number.isFinite(nightStart) && Number.isFinite(nightEnd) && nightEnd > nightStart;
  const start = isNight ? nightStart : day?.sunrise;
  const end = isNight ? nightEnd : day?.sunset;
  const hasPeriod = isNight ? hasNight : hasDay;
  const marker = $('period-marker');
  const visual = document.querySelector('.period-visual');

  visual.classList.toggle('is-night', isNight);
  $('period-start-label').textContent = isNight ? 'sunset' : 'sunrise';
  $('period-end-label').textContent = isNight ? 'sunrise' : 'sunset';
  $('period-start-time').textContent = !day ? '—' : !hasEvents ? (isNight ? 'No sunset' : 'No sunrise') : formatTime(start, timeZone);
  $('period-end-time').textContent = !day ? '—' : !hasEvents ? (isNight ? 'No sunrise' : 'No sunset') : formatTime(end, timeZone);
  $('period-label').textContent = isNight ? 'nighttime' : 'daylight';
  $('duration').textContent = !day ? '—' : !hasEvents ? formatDuration(86400)
    : isNight ? (hasNight ? formatDuration(end - start) : '—') : formatDuration(day.duration);
  $('period-state').textContent = !day ? '' : !hasEvents ? (isNight ? 'polar night' : 'midnight sun')
    : !hasDay ? 'events cross midnight' : isNight && !hasNight ? 'unavailable' : '';
  $('period-detail').textContent = isNight && hasNight ? `From sunset at ${formatTime(start, timeZone)} to ${isBeforeSunrise ? 'today’s' : 'tomorrow’s'} sunrise at ${formatTime(end, timeZone)}.` : '';
  document.querySelectorAll('.period-arc').forEach((arc) => arc.toggleAttribute('hidden', !hasPeriod));
  $('period-start-point').hidden = $('period-end-point').hidden = !hasPeriod;
  marker.hidden = !hasPeriod || now < start || now >= end;
  if (!marker.hidden) {
    const progress = (now - start) / (end - start);
    // The quadratic Bézier has a linear x coordinate.
    marker.style.left = `${(130 + 440 * progress) / 7}%`;
    marker.style.top = `${(118 - 356 * progress * (1 - progress)) / 1.5}%`;
  }
}

function formatDurationDifference(seconds, todaySeconds) {
  const difference = Math.round(seconds / 60) - Math.round(todaySeconds / 60);
  const minutes = Math.abs(difference);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  const value = [hours && `${hours}h`, (remainder || !hours) && `${remainder}m`].filter(Boolean).join(' ');
  return `${difference < 0 ? '-' : difference > 0 ? '+' : ''}${value}`;
}

async function fetchDays(endpoint, start, end, selected, signal) {
  const params = new URLSearchParams({ latitude: selected.lat, longitude: selected.lon, daily: 'sunrise,sunset,daylight_duration', start_date: start, end_date: end, timezone: selected.tz, timeformat: 'unixtime' });
  const response = await fetch(`${endpoint}?${params}`, { signal });
  if (!response.ok) throw new Error(`Open-Meteo returned ${response.status}`);
  const data = await response.json();
  if (!data.daily || !Array.isArray(data.daily.time) || !Array.isArray(data.daily.daylight_duration)) throw new Error('Open-Meteo returned incomplete data');
  // Daily timestamps use a fixed offset across DST transitions; the requested
  // start date and array index reliably identify each local calendar day.
  return data.daily.time.map((_, i) => ({ date: addDays(start, i), sunrise: data.daily.sunrise?.[i], sunset: data.daily.sunset?.[i], duration: data.daily.daylight_duration[i] }));
}

function svgElement(tag, attributes, text) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderChart(days, today, timeZone, selection) {
  chart.replaceChildren();
  const width = 700, left = 65, right = 12;
  const bounds = $('chart-wrap').getBoundingClientRect();
  // Match the available aspect ratio without stretching text or strokes.
  const height = fullscreenLayout.matches && bounds.width && bounds.height ? width * bounds.height / bounds.width : 374;
  const top = Math.min(38, height / 4), bottom = Math.min(34, height / 4);
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const xFor = (index) => left + (index / (days.length - 1)) * plotWidth;
  const yFor = (hours) => top + (hours / 24) * plotHeight;
  const localTime = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const localHours = (timestamp) => {
    const parts = Object.fromEntries(localTime.formatToParts(timestamp * 1000).map(({ type, value }) => [type, value]));
    return Number(parts.hour) + Number(parts.minute) / 60 + Number(parts.second) / 3600;
  };
  const points = days.map((day, index) => hasSunEvents(day)
    ? { x: xFor(index), sunrise: localHours(day.sunrise), sunset: localHours(day.sunset) }
    : null);
  const todayIndex = days.findIndex((day) => day.date === today);
  chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
  chart.setAttribute('role', 'group');

  let compactTimeLabels = false;
  for (let hours = 0; hours <= 24; hours += 3) {
    const y = yFor(hours);
    const label = hours === 0 || hours === 24 ? '12 am' : hours === 12 ? '12 pm' : `${hours % 12} ${hours < 12 ? 'am' : 'pm'}`;
    const text = svgElement('text', { x: left - 8, y: y + 4, 'text-anchor': 'end', class: 'axis-label' }, label);
    chart.append(svgElement('line', { x1: left, y1: y, x2: width - right, y2: y, class: 'grid-line' }), text);
    if (hours === 0) compactTimeLabels = plotHeight / 8 < parseFloat(getComputedStyle(text).fontSize) * 1.2;
    if (compactTimeLabels && hours % 6 !== 0) text.setAttribute('visibility', 'hidden');
  }
  days.forEach((day, index) => {
    if (day.date.endsWith('-01')) {
      const x = xFor(index);
      chart.append(svgElement('line', { x1: x, y1: top, x2: x, y2: top + plotHeight, class: 'month-grid-line' }));
      chart.append(svgElement('line', { x1: x, y1: top + plotHeight, x2: x, y2: top + plotHeight + 5, class: 'month-tick' }));
      chart.append(svgElement('text', { x, y: height - 8, 'text-anchor': index === 0 ? 'start' : 'middle', class: 'axis-label' }, formatDate(day.date, { month: 'short' }).toLowerCase()));
    }
  });

  // Break paths at polar days and midnight wraps instead of inventing events.
  function segmentsFor(key) {
    const segments = [];
    let segment = [];
    points.forEach((point) => {
      if (!point || (segment.length && Math.abs(point[key] - segment[segment.length - 1][key]) > 12)) {
        if (segment.length) segments.push(segment);
        segment = [];
      }
      if (point) segment.push(point);
    });
    if (segment.length) segments.push(segment);
    return segments;
  }
  // Shade only contiguous dates where both events occur in the same local day.
  let band = [];
  const drawBand = () => {
    if (band.length > 1) {
      const upper = band.map((point) => `${point.x},${yFor(point.sunrise)}`).join(' ');
      const lower = [...band].reverse().map((point) => `${point.x},${yFor(point.sunset)}`).join(' ');
      chart.append(svgElement('polygon', { points: `${upper} ${lower}`, class: 'daylight-band' }));
    }
    band = [];
  };
  points.forEach((point) => {
    if (!point || point.sunrise > point.sunset || (band.length && (Math.abs(point.sunrise - band[band.length - 1].sunrise) > 12 || Math.abs(point.sunset - band[band.length - 1].sunset) > 12))) drawBand();
    if (point && point.sunrise <= point.sunset) band.push(point);
  });
  drawBand();
  for (const key of ['sunrise', 'sunset']) {
    for (const segment of segmentsFor(key)) {
      chart.append(svgElement('polyline', { points: segment.map((point) => `${point.x},${yFor(point[key])}`).join(' '), class: `sun-line ${key}-line` }));
    }
  }

  const todayX = xFor(todayIndex);
  chart.append(svgElement('line', { x1: todayX, y1: top, x2: todayX, y2: top + plotHeight, class: 'today-line' }));
  const cursor = svgElement('line', { y1: top, y2: top + plotHeight, class: 'hover-line', visibility: 'hidden' });
  const marker = svgElement('g', { 'aria-hidden': 'true' });
  chart.append(cursor, marker);
  const hitArea = svgElement('rect', { x: left, y: top, width: plotWidth, height: plotHeight, class: 'chart-hit', tabindex: '0', role: 'slider', 'aria-label': 'Explore dates', 'aria-valuemin': '1', 'aria-valuemax': days.length });
  chart.append(hitArea);
  let selectedIndex = selection?.index ?? todayIndex;
  let exploring = selection?.exploring ?? false;
  function selectDay(index) {
    selectedIndex = Math.max(0, Math.min(days.length - 1, index));
    const day = days[selectedIndex];
    const dayOfMonth = Number(day.date.slice(-2));
    const suffix = dayOfMonth >= 11 && dayOfMonth <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[dayOfMonth % 10] || 'th');
    const label = `${formatDate(day.date, { month: 'long', day: 'numeric' })}${suffix}`;
    const times = hasSunEvents(day) ? `sunrise ${formatTime(day.sunrise, timeZone)}, sunset ${formatTime(day.sunset, timeZone)}` : (day.duration <= 0 ? 'no sunrise or sunset' : 'midnight sun');
    const duration = formatDuration(day.duration);
    const difference = exploring ? formatDurationDifference(day.duration, days[todayIndex].duration) : '';
    $('chart-detail').textContent = label;
    hitArea.setAttribute('aria-valuenow', selectedIndex + 1);
    hitArea.setAttribute('aria-valuetext', `${label}: ${times}, ${duration} daylight${difference ? `, ${difference} compared with today` : ''}`);
    const x = xFor(selectedIndex);
    cursor.setAttribute('x1', x);
    cursor.setAttribute('x2', x);
    cursor.setAttribute('visibility', selectedIndex === todayIndex ? 'hidden' : 'visible');

    marker.replaceChildren();
    const dateAnchor = x < left + 90 ? 'start' : x > width - right - 90 ? 'end' : 'middle';
    marker.append(svgElement('text', { x, y: top - 8, 'text-anchor': dateAnchor, class: 'point-label chart-date' }, label));
    const point = points[selectedIndex];
    const labelX = Math.max(left + 45, Math.min(width - right - 45, x));
    if (point) {
      for (const key of ['sunrise', 'sunset']) {
        const y = yFor(point[key]);
        const above = key === 'sunrise' ? y - top >= 28 : top + plotHeight - y < 28;
        marker.append(svgElement('circle', { cx: x, cy: y, r: 4, class: `chart-point ${key}-point` }));
        marker.append(svgElement('text', { x: labelX, y: y + (above ? -8 : 8), 'text-anchor': 'middle', 'dominant-baseline': above ? 'auto' : 'hanging', class: 'point-label' }, formatTime(day[key], timeZone)));
      }
    }
    const durationY = point && point.sunrise <= point.sunset
      ? (yFor(point.sunrise) + yFor(point.sunset)) / 2
      : top + plotHeight / 2;
    const narrowBand = point && Math.abs(yFor(point.sunrise) - yFor(point.sunset)) < 28;
    const durationAnchor = narrowBand ? (x > left + plotWidth / 2 ? 'end' : 'start') : 'middle';
    const durationX = narrowBand ? x + (durationAnchor === 'end' ? -10 : 10) : labelX;
    const durationLabel = svgElement('text', { x: durationX, y: durationY, 'text-anchor': durationAnchor, 'dominant-baseline': 'middle', class: 'point-label daylight-label' }, `${duration}${difference ? ` (${difference})` : ''}`);
    marker.append(durationLabel);
    if (!narrowBand) {
      const halfWidth = Math.max(45, durationLabel.getComputedTextLength() / 2 + 4);
      durationLabel.setAttribute('x', Math.max(left + halfWidth, Math.min(width - right - halfWidth, x)));
    }
  }
  resetChartSelection = () => { exploring = false; selectDay(todayIndex); };
  selectDay(selectedIndex);
  function selectPointerDay(event) {
    exploring = true;
    const bounds = chart.getBoundingClientRect();
    const x = (event.clientX - bounds.left) * width / bounds.width;
    selectDay(Math.round((x - left) / plotWidth * (days.length - 1)));
  }
  hitArea.addEventListener('pointermove', selectPointerDay);
  hitArea.addEventListener('pointerdown', selectPointerDay);
  hitArea.addEventListener('pointerleave', (event) => { if (event.pointerType === 'mouse' && document.activeElement !== hitArea) { exploring = false; selectDay(todayIndex); } });
  hitArea.addEventListener('focus', () => { exploring = true; selectDay(selectedIndex); });
  hitArea.addEventListener('blur', () => { exploring = false; selectDay(todayIndex); });
  hitArea.addEventListener('keydown', (event) => {
    let next = selectedIndex;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next--;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next++;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = days.length - 1;
    else return;
    event.preventDefault();
    selectDay(next);
  });
  if (selection?.focused) hitArea.focus({ preventScroll: true });
  redrawChart = () => renderChart(days, today, timeZone, {
    index: selectedIndex, exploring, focused: document.activeElement === hitArea
  });
}

async function load() {
  resetChartSelection = undefined;
  redrawChart = undefined;
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
  document.title = `daylight hours - ${selected.name.toLowerCase()}`;
  $('today-heading').textContent = 'loading daylight times…';
  updateDaylightVisual(null, null, null, selected.tz);
  $('chart-detail').textContent = 'hover or focus the chart for details';
  chart.setAttribute('hidden', '');
  $('chart-status').textContent = 'Loading daylight data…';
  $('chart-status').hidden = false;
  $('chart-wrap').setAttribute('aria-busy', 'true');
  $('retry').hidden = true;
  // The forecast endpoint cannot cover a full year. Its climate endpoint can,
  // and both return astronomical sunrise and sunset rather than weather data.
  const requests = [
    fetchDays('https://api.open-meteo.com/v1/forecast', addDays(today, -1), addDays(today, 1), selected, loadController.signal),
    fetchDays('https://climate-api.open-meteo.com/v1/climate', start, end, selected, loadController.signal)
  ];
  const [forecast, annual] = await Promise.allSettled(requests);
  if (version !== loadVersion) return;
  const validDay = (day) => day && Number.isFinite(day.duration) &&
    (day.duration <= 0 || day.duration >= 86400 || hasSunEvents(day));
  let currentDay;
  if (forecast.status === 'fulfilled' && forecast.value.length === 3 && forecast.value.slice(1).every(validDay)) {
    const [previousDay, todayData, nextDay] = forecast.value;
    currentDay = todayData;
    scheduleClock(today, currentDay, validDay(previousDay) ? previousDay : null, nextDay, selected.tz);
  } else {
    console.error('Could not load today’s daylight data:', forecast.reason || 'Incomplete data');
    $('today-heading').textContent = 'daylight times unavailable';
    $('period-state').textContent = 'unavailable';
    $('retry').hidden = false;
    scheduleClock(today, null, null, null, selected.tz);
  }
  const expectedCount = (Date.parse(`${year + 1}-01-01T00:00:00Z`) - Date.parse(`${year}-01-01T00:00:00Z`)) / 86400000;
  if (annual.status === 'fulfilled' && annual.value.length === expectedCount && annual.value.every(validDay)) {
    const days = annual.value;
    // Use the same values as the card for today's marker; model grids differ.
    if (currentDay) days[days.findIndex((day) => day.date === today)] = currentDay;
    renderChart(days, today, selected.tz);
    $('chart-status').hidden = true;
    chart.removeAttribute('hidden');
  } else {
    console.error('Could not load annual daylight data:', annual.reason || 'Incomplete data');
    $('chart-status').textContent = 'Couldn’t load yearly daylight data. Check your connection and try again.';
    $('retry').hidden = false;
  }
  $('chart-wrap').setAttribute('aria-busy', 'false');
}

function scheduleClock(date, currentDay, previousDay, nextDay, timeZone) {
  clearTimeout(clockTimer);
  if (todayIn(timeZone) !== date) { load(); return; }
  if (currentDay) {
    updateHeading(currentDay, nextDay);
    updateDaylightVisual(currentDay, previousDay, nextDay, timeZone);
  }
  clockTimer = setTimeout(() => scheduleClock(date, currentDay, previousDay, nextDay, timeZone), currentDay ? 1000 : 60000);
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
