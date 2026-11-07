'use strict';

(function () {
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

  function formatDurationDifference(seconds, todaySeconds) {
    const difference = Math.round(seconds / 60) - Math.round(todaySeconds / 60);
    const minutes = Math.abs(difference);
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    const value = hours ? `${hours}h${String(remainder).padStart(2, '0')}m` : `${remainder}m`;
    return `${difference < 0 ? '-' : difference > 0 ? '+' : ''}${value}`;
  }

  window.DaylightSolar = {
    todayIn,
    addDays,
    formatDate,
    formatTime,
    formatCountdown,
    hasSunEvents,
    sunIsUp,
    nightFor,
    formatDuration,
    spokenDuration,
    formatDurationDifference
  };
})();
