# Daylight hours

A small, dependency-free web app showing today’s sunrise, sunset, and daylight duration, plus a year-long chart of sunrise and sunset times in the selected location’s time zone. The heading counts down to sunrise or sunset using the browser clock, then counts down to tomorrow’s sunrise after sunset. Locations come from the same Open-Meteo geocoding service used by sunlight.kahvipatel.com. The URL accepts the same `lat`, `lon`, `tz`, and `n` parameters and can be shared.

![Daylight hours app showing sunrise, sunset, and the annual daylight chart](docs/screenshot.png)

Serve this directory with any static web server, for example:

```sh
cd daylight
python3 -m http.server 8000
```

Open <http://localhost:8000>. An internet connection is required for Open-Meteo. The forecast API supplies today and tomorrow; the climate API supplies the full calendar year. Both provide astronomical sunrise and sunset, not weather-dependent sunshine duration. Their grid coordinates can differ slightly; the chart uses the forecast values for today. Gaps in the lines indicate days without sunrise or sunset.
