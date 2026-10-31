# Daylight hours

This web app shows sunrise, sunset, and daylight duration for a selected location. It also shows a chart for the current year. The times use the time zone of the selected location.

![Daylight hours app showing sunrise, sunset, and the annual daylight chart](docs/screenshot.png)

The heading shows the time until the next sunrise or sunset. It uses the clock on your device.

Search for a city to select a location. The URL then includes the location parameters `lat`, `lon`, `tz`, and `n`. You can share this URL.

## Start the app

1. Start a static web server in the project directory. For example:

   ```sh
   python3 -m http.server 8000
   ```

2. Open <http://localhost:8000> in a browser.

## Data

You need an internet connection to get data from Open-Meteo. The forecast API gives data for today and tomorrow. The climate API gives data for the current year.

The sunrise and sunset times are astronomical. Clouds do not change these times. The grid positions for the two APIs can be different. For today, the chart uses data from the forecast API. Gaps in the chart show days without sunrise or sunset.
