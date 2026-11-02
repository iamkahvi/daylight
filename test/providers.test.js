const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openMeteo, weatherApi, localSolar, getDaysWithFallback, zonedTime } = require('../providers.js');

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

test('WeatherAPI normalizes local times, DST and polar responses', async (t) => {
  const oldFetch = global.fetch;
  t.after(() => { global.fetch = oldFetch; });
  global.fetch = async (url) => {
    const date = new URL(url).searchParams.get('dt');
    const astro = date === '2026-03-09' ? { sunrise: 'Polar Night', sunset: 'Polar Night' } : { sunrise: '07:30 AM', sunset: '06:45 PM' };
    return { ok: true, json: async () => ({ location: { tz_id: victoria.tz }, astronomy: { astro } }) };
  };
  const days = await weatherApi('test').getDays('2026-03-07', '2026-03-09', victoria, signal());
  assert.equal(new Date(days[0].sunrise * 1000).toISOString(), '2026-03-07T15:30:00.000Z');
  assert.equal(new Date(days[1].sunrise * 1000).toISOString(), '2026-03-08T14:30:00.000Z');
  assert.equal(days[1].duration, 40500);
  assert.equal(days[2].duration, 0);
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

test('malformed WeatherAPI times and mismatched local dates are rejected', async (t) => {
  const oldFetch = global.fetch;
  t.after(() => { global.fetch = oldFetch; });
  global.fetch = async () => ({ ok: true, json: async () => ({ location: { tz_id: 'UTC' }, astronomy: { astro: { sunrise: 'not a time', sunset: '06:45 PM' } } }) });
  await assert.rejects(weatherApi('test').getDays('2026-03-07', '2026-03-07', victoria, signal()));
  global.fetch = async () => ({ ok: true, json: async () => ({ location: { tz_id: 'UTC' }, astronomy: { astro: { sunrise: '01:00 AM', sunset: '06:45 PM' } } }) });
  await assert.rejects(weatherApi('test').getDays('2026-03-07', '2026-03-07', victoria, signal()));
});
