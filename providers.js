/* Daylight providers return one { date, sunrise, sunset, duration } per local
   calendar day. Event timestamps and duration are in seconds; polar days have
   null events and a duration of 0 or 86400. */
(function (root) {
  'use strict';
  const SunCalc = typeof module !== 'undefined' && module.exports ? require('./vendor/suncalc.js') : root.SunCalc;
  const DAY = 86400000;
  const dateFormatter = (tz) => new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  function partsAt(timestamp, tz) {
    return Object.fromEntries(dateFormatter(tz).formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value]));
  }
  function localDate(timestamp, tz) {
    const p = partsAt(timestamp, tz);
    return `${p.year}-${p.month}-${p.day}`;
  }
  function addDays(date, days) {
    const value = new Date(`${date}T12:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  }
  function datesBetween(start, end) {
    const dates = [];
    for (let date = start; date <= end; date = addDays(date, 1)) dates.push(date);
    return dates;
  }
  // Convert provider-local wall time to an absolute instant, including DST.
  function zonedTime(date, hour, minute, tz) {
    const target = Date.parse(`${date}T00:00:00Z`) + (hour * 60 + minute) * 60000;
    let instant = target;
    for (let i = 0; i < 4; i++) {
      const p = partsAt(instant, tz);
      const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
      const adjustment = target - wall;
      if (!adjustment) return instant / 1000;
      instant += adjustment;
    }
    throw new Error('Provider returned a nonexistent local time');
  }
  function parseTime(date, value, tz) {
    const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(value || '');
    if (!match || +match[1] < 1 || +match[1] > 12 || +match[2] > 59) throw new Error('WeatherAPI returned an invalid sun time');
    const hour = +match[1] % 12 + (match[3].toUpperCase() === 'PM' ? 12 : 0);
    return zonedTime(date, hour, +match[2], tz);
  }
  function validDay(day) {
    return day && Number.isFinite(day.duration) && day.duration >= 0 && day.duration <= 86400 &&
      ((day.duration === 0 || day.duration === 86400) ||
       (Number.isFinite(day.sunrise) && Number.isFinite(day.sunset)));
  }
  function validateDays(days, start, end) {
    const dates = datesBetween(start, end);
    if (!Array.isArray(days) || days.length !== dates.length || days.some((day, i) => day.date !== dates[i] || !validDay(day))) {
      throw new Error('Provider returned incomplete daylight data');
    }
    return days;
  }
  async function requestJson(url, signal, timeout = 8000) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeout);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  const openMeteo = {
    name: 'Open-Meteo',
    async getDays(start, end, selected, signal, kind) {
      const endpoint = kind === 'annual' ? 'https://climate-api.open-meteo.com/v1/climate' : 'https://api.open-meteo.com/v1/forecast';
      const params = new URLSearchParams({ latitude: selected.lat, longitude: selected.lon, daily: 'sunrise,sunset,daylight_duration', start_date: start, end_date: end, timezone: selected.tz, timeformat: 'unixtime' });
      const data = await requestJson(`${endpoint}?${params}`, signal);
      if (!Array.isArray(data.daily?.time) || !Array.isArray(data.daily?.daylight_duration)) throw new Error('Open-Meteo returned incomplete data');
      // The daily Unix timestamps use a fixed offset over DST, so use the index for calendar dates.
      return data.daily.time.map((_, i) => ({ date: addDays(start, i), sunrise: data.daily.sunrise?.[i], sunset: data.daily.sunset?.[i], duration: data.daily.daylight_duration[i] }));
    }
  };
  function weatherApi(key) {
    return {
      name: 'WeatherAPI.com',
      async getDays(start, end, selected, signal) {
        if (!key) throw new Error('WeatherAPI key is not configured');
        return Promise.all(datesBetween(start, end).map(async (date) => {
          const params = new URLSearchParams({ key, q: `${selected.lat},${selected.lon}`, dt: date });
          const data = await requestJson(`https://api.weatherapi.com/v1/astronomy.json?${params}`, signal);
          const astro = data.astronomy?.astro;
          const tz = data.location?.tz_id;
          if (!astro || !tz) throw new Error('WeatherAPI returned incomplete astronomy data');
          if (astro.sunrise === 'Polar Night' && astro.sunset === 'Polar Night') return { date, sunrise: null, sunset: null, duration: 0 };
          if (astro.sunrise === 'Polar Day' && astro.sunset === 'Polar Day') return { date, sunrise: null, sunset: null, duration: 86400 };
          const sunrise = parseTime(date, astro.sunrise, tz);
          const sunset = parseTime(date, astro.sunset, tz);
          if (localDate(sunrise * 1000, selected.tz) !== date || localDate(sunset * 1000, selected.tz) !== date || sunset <= sunrise) {
            throw new Error('WeatherAPI events do not match the selected local day');
          }
          return { date, sunrise, sunset, duration: sunset - sunrise };
        }));
      }
    };
  }
  const localSolar = {
    name: 'SunCalc',
    async getDays(start, end, selected, signal) {
      return datesBetween(start, end).map((date) => {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const noon = zonedTime(date, 12, 0, selected.tz) * 1000;
        const times = SunCalc.getTimes(new Date(noon), selected.lat, selected.lon);
        const sunrise = times.sunrise.getTime() / 1000;
        const sunset = times.sunset.getTime() / 1000;
        if (Number.isFinite(sunrise) && Number.isFinite(sunset)) {
          return { date, sunrise, sunset, duration: sunset - sunrise };
        }
        // SunCalc's event angle is -0.833° (refraction and solar radius).
        const altitude = SunCalc.getPosition(times.solarNoon, selected.lat, selected.lon).altitude;
        if (!Number.isFinite(altitude)) throw new Error('Unable to calculate solar position');
        return { date, sunrise: null, sunset: null, duration: altitude > -0.833 * Math.PI / 180 ? 86400 : 0 };
      });
    }
  };
  async function getDaysWithFallback(providers, start, end, selected, signal, kind) {
    const errors = [];
    for (const provider of providers) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        const days = validateDays(await provider.getDays(start, end, selected, signal, kind), start, end);
        return { days, provider: provider.name };
      } catch (error) {
        if (signal?.aborted) throw error;
        errors.push(`${provider.name}: ${error.message}`);
      }
    }
    throw new Error(errors.join('; '));
  }
  const api = { openMeteo, weatherApi, localSolar, getDaysWithFallback, validateDays, zonedTime };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DaylightProviders = api;
})(globalThis);
