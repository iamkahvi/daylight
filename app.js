'use strict';

const $ = (id) => document.getElementById(id);
const { todayIn, addDays, formatDate, formatCountdown, hasSunEvents, sunIsUp } = window.DaylightSolar;
const { locationFromUrl, createLocationPicker } = window.DaylightLocation;
const { openMeteo, sunriseSunset, localSolar, getDaysWithFallback } = window.DaylightProviders;
const providers = [openMeteo, sunriseSunset, localSolar];

// Each load owns two independent request states; a newer generation supersedes both.
const app = {
  location: locationFromUrl(),
  generation: 0,
  controller: null,
  clockTimer: undefined,
  updateCurrentVisual: () => {}
};
const period = window.DaylightPeriod.createPeriodView();
const chart = window.DaylightChart.createChart({
  onPreview: (day, timeZone, night) => period.update(day, null, null, timeZone, true, night),
  onCurrent: () => app.updateCurrentVisual()
});
const locationPicker = createLocationPicker({
  onSelect(location) {
    app.location = location;
    load();
  }
});

function setDisplayMode(day, locationName) {
  const isUp = sunIsUp(day);
  if (isUp === null) return;
  const night = !isUp;
  $('app-title').textContent = night ? 'nighttime hours' : 'daylight hours';
  $('chart-title').textContent = night ? 'the year at night' : 'the year in daylight';
  document.title = `${night ? 'nighttime' : 'daylight'} - ${locationName.toLowerCase()}`;
  chart.setMode(night);
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

async function load() {
  chart.clear();
  const selected = { ...app.location };
  clearTimeout(app.clockTimer);
  const version = ++app.generation;
  if (app.controller) app.controller.abort();
  app.controller = new AbortController();
  const today = todayIn(selected.tz);
  const year = Number(today.slice(0, 4));
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  $('current-date').dateTime = today;
  $('current-date').textContent = formatDate(today, { weekday: 'long', month: 'long', day: 'numeric' });
  $('location-name').textContent = selected.name;
  chart.setMode(false);
  setDisplayMode({ sunrise: null, sunset: null, duration: 86400 }, selected.name);
  $('today-heading').textContent = 'loading daylight times…';
  app.updateCurrentVisual = () => period.update(null, null, null, selected.tz);
  app.updateCurrentVisual();
  $('chart-detail').textContent = 'hover or focus the chart for details';
  $('chart').setAttribute('hidden', '');
  $('chart-status').textContent = 'Loading daylight data…';
  $('chart-status').hidden = false;
  $('chart-wrap').setAttribute('aria-busy', 'true');
  $('retry').hidden = true;

  const requests = { forecast: { status: 'loading' }, annual: { status: 'loading' } };
  function mergeForecast() {
    if (requests.forecast.status !== 'ready' || requests.annual.status !== 'ready') return;
    for (const day of requests.forecast.days) {
      const index = requests.annual.days.findIndex((item) => item.date === day.date);
      if (index !== -1) requests.annual.days[index] = day;
      else if (requests.annual.followingDay.date === day.date) Object.assign(requests.annual.followingDay, day);
    }
  }
  const forecast = getDaysWithFallback(providers, addDays(today, -1), addDays(today, 1), selected, app.controller.signal, 'forecast')
    .then(({ days }) => {
      if (version !== app.generation) return;
      requests.forecast = { status: 'ready', days };
      const [previousDay, currentDay, nextDay] = days;
      app.updateCurrentVisual = () => period.update(currentDay, previousDay, nextDay, selected.tz);
      mergeForecast();
      scheduleClock(today, currentDay, nextDay, selected.tz);
      if (version !== app.generation) return;
      if (requests.annual.status === 'ready') chart.redraw();
    }).catch((error) => {
      if (version !== app.generation) return;
      requests.forecast = { status: 'error', error };
      console.error('Could not load today’s daylight data:', error);
      $('today-heading').textContent = 'daylight times unavailable';
      app.updateCurrentVisual = () => {
        period.update(null, null, null, selected.tz);
        $('period-state').textContent = 'unavailable';
      };
      app.updateCurrentVisual();
      $('retry').hidden = false;
      scheduleClock(today, null, null, selected.tz);
    });
  // Include Jan 1 of the next year for Dec 31's night. On New Year's Day,
  // include the previous Dec 31 as well, for the night still in progress.
  const annualStart = today === start ? addDays(start, -1) : start;
  const annual = getDaysWithFallback(providers, annualStart, addDays(end, 1), selected, app.controller.signal, 'annual')
    .then(({ days }) => {
      if (version !== app.generation) return;
      requests.annual = { status: 'ready', days: days.slice(0, -1), followingDay: days[days.length - 1] };
      // Adjacent forecast events keep the current night's interval consistent.
      mergeForecast();
      chart.setData(requests.annual.days, today, selected.tz, requests.annual.followingDay);
      $('chart-status').hidden = true;
      $('chart').removeAttribute('hidden');
      $('chart-wrap').setAttribute('aria-busy', 'false');
    }).catch((error) => {
      if (version !== app.generation) return;
      requests.annual = { status: 'error', error };
      console.error('Could not load annual daylight data:', error);
      $('chart-status').textContent = 'Couldn’t load yearly daylight data. Check your connection and try again.';
      $('retry').hidden = false;
      $('chart-wrap').setAttribute('aria-busy', 'false');
    });
  await Promise.all([forecast, annual]);
}

function scheduleClock(date, currentDay, nextDay, timeZone) {
  clearTimeout(app.clockTimer);
  if (todayIn(timeZone) !== date) { load(); return; }
  if (currentDay) {
    setDisplayMode(currentDay, app.location.name);
    updateHeading(currentDay, nextDay);
    if (!chart.isPreview()) app.updateCurrentVisual();
  }
  app.clockTimer = setTimeout(() => scheduleClock(date, currentDay, nextDay, timeZone), currentDay ? 1000 : 60000);
}

$('retry').addEventListener('click', load);
window.addEventListener('popstate', () => {
  app.location = locationFromUrl();
  locationPicker.setLocation(app.location);
  load();
});
load();
