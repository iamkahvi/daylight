# Daylight hours

This web app shows sunrise, sunset, and the duration of the current day or night for a selected location. It also shows a chart for the current year, switching between daylight and nighttime when the sun rises or sets. The times use the time zone of the selected location.

![Daylight hours app showing sunrise, sunset, and the annual daylight chart](docs/screenshot.png)

The heading shows the time until the next sunrise or sunset. It uses the clock on your device. The card shows the percentage of the current day or night that has elapsed, updating with the clock. The percentage is unavailable when the interval’s endpoints are unknown; chart previews show the selected date’s duration instead. The arc widens with the duration, reaching its maximum width at 18 hours; its marker shows elapsed time through the current day or night, not the sun’s actual position. At night, its duration runs from sunset to the next sunrise.

Use the toggle at the top right of the yearly chart to enable or disable date selection. It starts off on touch-first devices and on otherwise. When enabled, hover or touch the chart, or focus it and use the arrow keys, to show a date in the top card. At night, each date represents the night from that date’s sunset to the following sunrise. The countdown stays on the current day; the card returns to the current day or night when you leave the chart, focus elsewhere, tap outside, or turn exploration off. The elapsed-time marker is hidden while exploring the chart.

Search for a city to select a location. The URL then includes the location parameters `lat`, `lon`, `tz`, and `n`. You can share this URL.

The theme follows your system setting until you use the button in the top right. Your chosen light or dark theme is saved in your browser and does not affect the shared location URL.

## Start the app

1. Start a static web server in the project directory. For example:

   ```sh
   python3 -m http.server 8000
   ```

2. Open <http://localhost:8000> in a browser. No API key is required.

## Data

Open-Meteo supplies yesterday, today and tomorrow from its forecast API and the current year from its climate API. If either request fails, the app tries [Sunrise-Sunset.org](https://sunrise-sunset.org/api), then local [SunCalc](https://github.com/mourner/suncalc) calculations. City search still uses Open-Meteo geocoding.

The sunrise and sunset times are astronomical. Clouds do not change these times. Providers use different locations and algorithms, so times can differ slightly. The chart uses the same data as the card for today. Gaps show days without sunrise or sunset.

Provider adapters live in `providers.js`. To add a provider, implement `getDays(start, end, location, signal, kind)` returning one `{ date, sunrise, sunset, duration }` per local date, with event timestamps and duration in seconds. Return null events and a duration of 0 or 86400 for polar night or day; if only one event occurs, return null for the other event and duration. Add the adapter to the appropriate ordered fallback list in `load()` in `app.js`. Failed, timed-out or incomplete responses move to the next provider; changing location cancels outstanding requests.

Run the tests with `node --test test/*.test.js`.
