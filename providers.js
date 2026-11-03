/* Daylight providers return one { date, sunrise, sunset, duration } per local
   calendar day. Event timestamps and duration are in seconds; polar days have
   null events and a duration of 0 or 86400. A partial day has one null event
   and a null duration. */
(function (root) {
  'use strict';
  const SunCalc = typeof module !== 'undefined' && module.exports ? require('./vendor/suncalc.js') : root.SunCalc;
  const dateFormatter = (tz) => new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  function partsAt(timestamp, tz) {
    return Object.fromEntries(dateFormatter(tz).formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value]));
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
  function validDay(day) {
    if (!day) return false;
    if (day.duration === null) {
      return (Number.isFinite(day.sunrise) && day.sunset === null) ||
        (day.sunrise === null && Number.isFinite(day.sunset));
    }
    return Number.isFinite(day.duration) && day.duration >= 0 && day.duration <= 86400 &&
      ((day.duration === 0 || day.duration === 86400) ||
       (Number.isFinite(day.sunrise) && Number.isFinite(day.sunset)));
  }
  function validateDays(days, start, end) {
    const dates = datesBetween(start, end);
    if (!Array.isArray(days) || days.length !== dates.length || days.some((day, i) => !validDay(day) || day.date !== dates[i])) {
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
  const sunriseSunset = {
    name: 'Sunrise-Sunset.org',
    async getDays(start, end, selected, signal) {
      const params = new URLSearchParams({ lat: selected.lat, lng: selected.lon, date_start: start, date_end: end, tz: selected.tz, time_format: 'unix' });
      const data = await requestJson(`https://api.sunrise-sunset.org/v2?${params}`, signal);
      if (!Array.isArray(data.days) || data.tzid !== selected.tz) throw new Error('Sunrise-Sunset.org returned incomplete data');
      return data.days.map((day) => {
        if (!day || !['normal', 'polar_night', 'midnight_sun'].includes(day.sun_status)) throw new Error('Sunrise-Sunset.org returned an invalid sun status');
        const result = { date: day.date, sunrise: day.sunrise, sunset: day.sunset, duration: day.day_length };
        if (day.sun_status === 'normal' ? !validDay(result) || result.duration === 0 || result.duration === 86400 :
          result.sunrise !== null || result.sunset !== null || result.duration !== (day.sun_status === 'polar_night' ? 0 : 86400)) {
          throw new Error('Sunrise-Sunset.org returned invalid daylight data');
        }
        return result;
      });
    }
  };
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
  const api = { openMeteo, sunriseSunset, localSolar, getDaysWithFallback, validateDays, zonedTime };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DaylightProviders = api;
})(globalThis);
