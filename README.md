# Daylight hours

This web app shows sunrise, sunset, and daylight duration for a selected location. It also shows a chart for the current year. The times use the time zone of the selected location.

![Daylight hours app showing sunrise, sunset, and the annual daylight chart](docs/screenshot.png)

The heading shows the time until the next sunrise or sunset. It uses the clock on your device. The arc widens with the displayed duration, reaching its maximum width at 18 hours; its marker shows elapsed time through the current day or night, not the sun’s actual position. At night, its duration runs from sunset to the next sunrise.

Hover over or touch the yearly chart to show that date’s sunrise, sunset, and daylight duration in the top card. You can also focus the chart and use the arrow keys. The countdown stays on the current day; the card returns to the current day or night when you leave the chart or tap outside it. The elapsed-time marker is hidden while exploring the chart.

Search for a city to select a location. The URL then includes the location parameters `lat`, `lon`, `tz`, and `n`. You can share this URL.

## Start the app

1. Start a static web server in the project directory. For example:

   ```sh
   python3 -m http.server 8000
   ```

2. Open <http://localhost:8000> in a browser.

## Data

You need an internet connection to get data from Open-Meteo. The forecast API gives data for yesterday, today, and tomorrow. The climate API gives data for the current year.

The sunrise and sunset times are astronomical. Clouds do not change these times. The grid positions for the two APIs can be different. For today, the chart uses data from the forecast API. Gaps in the chart show days without sunrise or sunset.
