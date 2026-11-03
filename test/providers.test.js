const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openMeteo, sunriseSunset, localSolar, getDaysWithFallback, validateDays, zonedTime } = require('../providers.js');

const victoria = { lat: 48.4284, lon: -123.3656, tz: 'America/Vancouver' };
const signal = () => new AbortController().signal;

test('local calculations cover a leap year and match known Victoria sunrise', async () => {
  const days = await localSolar.getDays('2024-01-01', '2024-12-31', victoria, signal());
  assert.equal(days.length, 366);
  assert.equal(days[59].date, '2024-02-29');
  const day = days.find(d => d.date === '2024-06-21');
  const sunrise = new Date(day.sunrise * 1000);
  assert.equal(new Intl.DateTimeFormat('en-GB', { timeZone: victoria.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(sunrise).slice(0, 2), '05');
  assert.ok(day.duration > 15 * 3600 && day.duration < 17 * 3600);
});

test('local calculations preserve the selected calendar date across the date line', async () => {
  const apia = { lat: -13.83, lon: -171.75, tz: 'Pacific/Apia' };
  const day = (await localSolar.getDays('2026-06-21', '2026-06-21', apia, signal()))[0];
  const localDate = (time) => new Intl.DateTimeFormat('en-CA', { timeZone: apia.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time * 1000));
  assert.equal(localDate(day.sunrise), day.date);
  assert.equal(localDate(day.sunset), day.date);
});

test('local calculations classify polar day and night', async () => {
  const tromso = { lat: 69.6492, lon: 18.9553, tz: 'Europe/Oslo' };
  const summer = (await localSolar.getDays('2026-06-21', '2026-06-21', tromso, signal()))[0];
  const winter = (await localSolar.getDays('2026-12-21', '2026-12-21', tromso, signal()))[0];
  assert.equal(summer.duration, 86400);
  assert.equal(winter.duration, 0);
  assert.equal(summer.sunrise, null);
  assert.equal(winter.sunset, null);
});

test('wall time conversion uses the date-specific DST offset', () => {
  assert.equal(new Date(zonedTime('2026-03-07', 7, 30, victoria.tz) * 1000).toISOString(), '2026-03-07T15:30:00.000Z');
  assert.equal(new Date(zonedTime('2026-03-08', 7, 30, victoria.tz) * 1000).toISOString(), '2026-03-08T14:30:00.000Z');
  assert.throws(() => zonedTime('2026-03-08', 2, 30, victoria.tz));
});

test('Sunrise-Sunset.org requests one date range in the selected timezone and normalizes its data', async (t) => {
  const oldFetch = global.fetch;
  t.after(() => { global.fetch = oldFetch; });
  const fixture = [
    { date: '2026-03-07', sunrise: 1772897400, sunset: 1772937900, day_length: 40500, sun_status: 'normal' },
    { date: '2026-03-08', sunrise: 1772980200, sunset: 1773020700, day_length: 40500, sun_status: 'normal' },
    { date: '2026-03-09', sunrise: null, sunset: null, day_length: 0, sun_status: 'polar_night' },
    { date: '2026-03-10', sunrise: null, sunset: null, day_length: 86400, sun_status: 'midnight_sun' },
    { date: '2026-03-11', sunrise: 1773223200, sunset: null, day_length: null, sun_status: 'normal' }
  ];
  let calls = 0;
  global.fetch = async (url) => {
    calls++;
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, 'https://api.sunrise-sunset.org/v2');
    assert.equal(parsed.searchParams.get('date_start'), '2026-03-07');
    assert.equal(parsed.searchParams.get('date_end'), '2026-03-11');
    assert.equal(parsed.searchParams.get('tz'), victoria.tz);
    assert.equal(parsed.searchParams.get('time_format'), 'unix');
    return { ok: true, json: async () => ({ tzid: victoria.tz, days: fixture }) };
  };
  const days = await sunriseSunset.getDays('2026-03-07', '2026-03-11', victoria, signal());
  assert.equal(calls, 1);
  assert.equal(days[0].sunrise, fixture[0].sunrise);
  assert.equal(days[1].duration, 40500);
  assert.equal(days[2].duration, 0);
  assert.equal(days[3].duration, 86400);
  assert.equal(days[4].sunset, null);
  assert.equal(days[4].duration, null);
  assert.equal(validateDays(days, '2026-03-07', '2026-03-11'), days);
});

test('falls back on HTTP failure and incomplete data, and stops on abort', async (t) => {
  const oldFetch = global.fetch;
  t.after(() => { global.fetch = oldFetch; });
  global.fetch = async () => ({ ok: false, status: 503 });
  const bad = { name: 'broken', getDays: async () => [] };
  const result = await getDaysWithFallback([openMeteo, bad, localSolar], '2026-11-01', '2026-11-02', victoria, signal(), 'forecast');
  assert.equal(result.provider, 'SunCalc');
  assert.equal(result.days.length, 2);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(getDaysWithFallback([localSolar], '2026-11-01', '2026-11-02', victoria, controller.signal, 'forecast'), { name: 'AbortError' });
});

test('Sunrise-Sunset.org rejects invalid, missing and inconsistent data', async (t) => {
  const oldFetch = global.fetch;
  t.after(() => { global.fetch = oldFetch; });
  const valid = { date: '2026-03-07', sunrise: 100, sunset: 200, day_length: 100, sun_status: 'normal' };
  let data;
  global.fetch = async () => ({ ok: true, json: async () => data });
  for (const response of [
    { tzid: 'UTC', days: [valid] },
    { tzid: victoria.tz, days: [{ ...valid, sunrise: '100' }] },
    { tzid: victoria.tz, days: [{ ...valid, sun_status: 'unknown' }] },
    { tzid: victoria.tz, days: [{ ...valid, sun_status: 'polar_night' }] },
    { tzid: victoria.tz, days: [{ ...valid, sunrise: null, sunset: null, day_length: null }] }
  ]) {
    data = response;
    await assert.rejects(sunriseSunset.getDays('2026-03-07', '2026-03-07', victoria, signal()));
  }
  data = { tzid: victoria.tz, days: [] };
  const result = await getDaysWithFallback([sunriseSunset, localSolar], '2026-03-07', '2026-03-07', victoria, signal(), 'annual');
  assert.equal(result.provider, 'SunCalc');
});

test('Sunrise-Sunset.org handles an annual range, a leap day, and midnight-wrapping events', async (t) => {
  const oldFetch = global.fetch;
  t.after(() => { global.fetch = oldFetch; });
  const days = Array.from({ length: 366 }, (_, i) => {
    const date = new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
    return { date, sunrise: 200, sunset: 100, day_length: 86300, sun_status: 'normal' };
  });
  global.fetch = async () => ({ ok: true, json: async () => ({ tzid: victoria.tz, days }) });
  const result = await getDaysWithFallback([sunriseSunset], '2024-01-01', '2024-12-31', victoria, signal(), 'annual');
  assert.equal(result.days.length, 366);
  assert.equal(result.days[59].date, '2024-02-29');
  assert.equal(result.days[59].sunset, 100);
});

test('Open-Meteo failure falls back to Sunrise-Sunset.org before local calculations', async (t) => {
  const oldFetch = global.fetch;
  t.after(() => { global.fetch = oldFetch; });
  global.fetch = async (url) => url.includes('open-meteo.com') ? { ok: false, status: 503 } : {
    ok: true, json: async () => ({ tzid: victoria.tz, days: [{ date: '2026-03-07', sunrise: 100, sunset: 200, day_length: 100, sun_status: 'normal' }] })
  };
  const result = await getDaysWithFallback([openMeteo, sunriseSunset, localSolar], '2026-03-07', '2026-03-07', victoria, signal(), 'annual');
  assert.equal(result.provider, 'Sunrise-Sunset.org');
});
