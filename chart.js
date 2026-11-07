'use strict';

window.DaylightChart = {
  createChart({ onPreview, onCurrent }) {
    const $ = (id) => document.getElementById(id);
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const { formatDate, formatTime, formatDuration, spokenDuration, formatDurationDifference, hasSunEvents, nightFor } = window.DaylightSolar;
    const chart = $('chart');
    const RETURN_DURATION = 180;
    const easeOutCubic = (progress) => 1 - (1 - progress) ** 3;
    const fullscreenLayout = window.matchMedia('(max-width:600px), (max-height:500px) and (pointer:coarse)');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let chartNight = false;
    let chartInteractive = !window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    let days, today, timeZone, followingDay;
    let resetChartSelection;
    let redrawChart;
    const selectionState = { mode: 'current', index: null, source: undefined };
    const isPreview = () => selectionState.mode === 'preview';
    let outsidePointer;
    let chartReturn;
    let renderVersion = 0;

    function updateChartDescription() {
      const chartText = chartNight
        ? 'The upper line shows sunset and the lower line shows the following sunrise, from noon to noon. The shaded area shows the night beginning on each date.'
        : 'The upper line shows sunrise and the lower line shows sunset. The shaded area shows daylight.';
      const interactionText = chartInteractive
        ? 'Focus the chart and use the left and right arrow keys to explore dates.'
        : 'Chart exploration is off. Use the explore toggle to enable it.';
      $('chart-description').textContent = `${chartText} The dashed line marks today. ${interactionText}`;
    }

    function updateChartToggle() {
      $('chart-toggle').setAttribute('aria-pressed', String(chartInteractive));
      $('chart-wrap').classList.toggle('is-interactive', chartInteractive);
      updateChartDescription();
    }

    function stopChartReturn() {
      if (!chartReturn) return;
      cancelAnimationFrame(chartReturn.frame);
      chartReturn.cursor.setAttribute('x1', chartReturn.target);
      chartReturn.cursor.setAttribute('x2', chartReturn.target);
      chartReturn.cursor.setAttribute('visibility', 'hidden');
      chartReturn = undefined;
    }

    function svgElement(tag, attributes, text) {
      const element = document.createElementNS(SVG_NS, tag);
      for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
      if (text !== undefined) element.textContent = text;
      return element;
    }

    function chartTimeBadge(parent, x, y, anchor, value, className, bounds) {
      const group = svgElement('g', { class: 'chart-time-badge' });
      const rect = svgElement('rect', { class: 'chart-time-background' });
      const text = svgElement('text', { x, y, 'text-anchor': anchor, 'dominant-baseline': 'central', class: className }, value);
      group.append(rect, text);
      parent.append(group);
      const fontSize = parseFloat(getComputedStyle(text).fontSize) || 13;
      const paddingX = fontSize * 0.3, paddingY = fontSize * 0.12;
      const textWidth = value.length * fontSize * 0.6;
      const offset = (anchor === 'middle' ? textWidth / 2 : anchor === 'end' ? textWidth : 0) + paddingX;
      if (bounds) {
        x = Math.max(bounds.left + offset, Math.min(bounds.right - (textWidth + paddingX * 2 - offset), x));
        text.setAttribute('x', x);
      }
      const left = x - offset;
      for (const [name, value] of Object.entries({ x: left, y: y - fontSize / 2 - paddingY, width: textWidth + paddingX * 2, height: fontSize + paddingY * 2, rx: fontSize * 0.32 })) rect.setAttribute(name, value);
    }

    function renderChart({ focused = false } = {}) {
      if (!days) return;
      const version = ++renderVersion;
      stopChartReturn();
      const night = chartNight;
      const nightDays = followingDay ? [...days, followingDay] : days;
      const nights = night ? days.map((_, index) => nightFor(nightDays, index)) : null;
      const upperKey = night ? 'sunset' : 'sunrise';
      const lowerKey = night ? 'sunrise' : 'sunset';
      chart.replaceChildren();
      const width = 700, left = 12, right = 12;
      const bounds = $('chart-wrap').getBoundingClientRect();
      // Match the available aspect ratio without stretching text or strokes.
      const height = fullscreenLayout.matches && bounds.width && bounds.height ? width * bounds.height / bounds.width : 374;
      const top = Math.min(24, height / 4), bottom = Math.min(34, height / 4);
      const plotWidth = width - left - right, plotHeight = height - top - bottom;
      const xFor = (index) => left + (index / (days.length - 1)) * plotWidth;
      const yFor = (hours) => top + (hours / 24) * plotHeight;
      const localTime = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
      const localHours = (timestamp) => {
        const parts = Object.fromEntries(localTime.formatToParts(timestamp * 1000).map(({ type, value }) => [type, value]));
        return Number(parts.hour) + Number(parts.minute) / 60 + Number(parts.second) / 3600;
      };
      const points = days.map((day, index) => {
        if (night) {
          const period = nights[index];
          const clock = (time) => Number.isFinite(time) ? (localHours(time) + 12) % 24 : null;
          const sunset = clock(period.start), sunrise = clock(period.end);
          // Noon-to-noon cannot represent a longer or midnight-wrapping interval.
          if (period.duration > 86400 || (sunset !== null && sunrise !== null && sunset > sunrise)) return null;
          return sunset !== null || sunrise !== null ? { x: xFor(index), sunset, sunrise } : null;
        }
        return hasSunEvents(day) || day.duration === null
          ? { x: xFor(index), sunrise: Number.isFinite(day.sunrise) ? localHours(day.sunrise) : null, sunset: Number.isFinite(day.sunset) ? localHours(day.sunset) : null }
          : null;
      });
      const todayIndex = days.findIndex((day) => day.date === today);
      // Before sunrise the ongoing night began yesterday, not tonight.
      const todayDay = days[todayIndex];
      const currentIndex = night && todayIndex > 0 && Number.isFinite(todayDay?.sunrise) &&
        Date.now() / 1000 < todayDay.sunrise && nights[todayIndex - 1].end === todayDay.sunrise
        ? todayIndex - 1 : todayIndex;
      chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
      chart.setAttribute('role', chartInteractive ? 'group' : 'img');

      for (let hours = 0; hours <= 24; hours += 3) {
        const y = yFor(hours);
        chart.append(svgElement('line', { x1: left, y1: y, x2: width - right, y2: y, class: 'grid-line' }));
      }
      const monthLabels = [];
      days.forEach((day, index) => {
        if (day.date.endsWith('-01')) {
          const x = xFor(index);
          chart.append(svgElement('line', { x1: x, y1: top, x2: x, y2: top + plotHeight, class: 'month-grid-line' }));
          chart.append(svgElement('line', { x1: x, y1: top + plotHeight, x2: x, y2: top + plotHeight + 5, class: 'month-tick' }));
          const text = svgElement('text', { x, y: height - 8, 'text-anchor': index === 0 ? 'start' : 'middle', class: 'axis-label month-axis-label' }, formatDate(day.date, { month: 'short' }).toLowerCase());
          chart.append(text);
          monthLabels.push(text);
        }
      });

      // Break paths at polar days and midnight wraps instead of inventing events.
      function segmentsFor(key) {
        const segments = [];
        let segment = [];
        points.forEach((point) => {
          if (!point || point[key] === null || (segment.length && Math.abs(point[key] - segment[segment.length - 1][key]) > 12)) {
            if (segment.length) segments.push(segment);
            segment = [];
          }
          if (point && point[key] !== null) segment.push(point);
        });
        if (segment.length) segments.push(segment);
        return segments;
      }
      // Shade only contiguous dates where both events occur in the same local day.
      let band = [];
      const drawBand = () => {
        if (band.length > 1) {
          const upper = band.map((point) => `${point.x},${yFor(point[upperKey])}`).join(' ');
          const lower = [...band].reverse().map((point) => `${point.x},${yFor(point[lowerKey])}`).join(' ');
          chart.append(svgElement('polygon', { points: `${upper} ${lower}`, class: night ? 'night-band' : 'daylight-band' }));
        }
        band = [];
      };
      points.forEach((point) => {
        const complete = point && point.sunrise !== null && point.sunset !== null;
        if (!complete || point[upperKey] > point[lowerKey] || (band.length && (Math.abs(point.sunrise - band[band.length - 1].sunrise) > 12 || Math.abs(point.sunset - band[band.length - 1].sunset) > 12))) drawBand();
        if (complete && point[upperKey] <= point[lowerKey]) band.push(point);
      });
      drawBand();
      for (const key of ['sunrise', 'sunset']) {
        for (const segment of segmentsFor(key)) {
          chart.append(svgElement('polyline', { points: segment.map((point) => `${point.x},${yFor(point[key])}`).join(' '), class: `sun-line ${key}-line` }));
        }
      }

      const todayX = xFor(todayIndex), currentX = xFor(currentIndex);
      chart.append(svgElement('line', { x1: todayX, y1: top, x2: todayX, y2: top + plotHeight, class: 'today-line' }));
      const cursor = svgElement('line', { y1: top, y2: top + plotHeight, class: 'hover-line', visibility: 'hidden' });
      const marker = svgElement('g', { 'aria-hidden': 'true' });
      chart.append(cursor, marker);
      const hitArea = svgElement('rect', {
        x: left, y: top, width: plotWidth, height: plotHeight, class: 'chart-hit',
        ...(chartInteractive ? { tabindex: '0', role: 'slider', 'aria-label': 'Explore dates', 'aria-valuemin': '1', 'aria-valuemax': days.length } : { 'aria-hidden': 'true' })
      });
      chart.append(hitArea);
      if (!isPreview()) selectionState.index = currentIndex;
      let restoringFocus = false;
      function selectDay(index) {
        if (version !== renderVersion) return;
        stopChartReturn();
        selectionState.index = Math.max(0, Math.min(days.length - 1, index));
        const day = days[selectionState.index];
        if (isPreview()) onPreview?.(day, timeZone, night ? nights[selectionState.index] : null);
        else onCurrent?.();
        const label = formatDate(day.date, { month: 'short', day: 'numeric' });
        const period = night ? nights[selectionState.index] : null;
        const times = night
          ? `${Number.isFinite(period.start) ? `sunset ${formatTime(period.start, timeZone)}` : 'no sunset'}, ${Number.isFinite(period.end) ? `following sunrise ${formatTime(period.end, timeZone)}` : 'following sunrise unavailable'}`
          : hasSunEvents(day) || day.duration === null
            ? `${Number.isFinite(day.sunrise) ? `sunrise ${formatTime(day.sunrise, timeZone)}` : 'no sunrise'}, ${Number.isFinite(day.sunset) ? `sunset ${formatTime(day.sunset, timeZone)}` : 'no sunset'}`
            : (day.duration <= 0 ? 'no sunrise or sunset' : 'midnight sun');
        const seconds = night ? period.duration : day.duration;
        const currentSeconds = night ? nights[currentIndex].duration : days[currentIndex].duration;
        const duration = formatDuration(seconds);
        const difference = isPreview() && Number.isFinite(seconds) && Number.isFinite(currentSeconds) ? formatDurationDifference(seconds, currentSeconds) : '';
        $('chart-detail').textContent = label;
        if (chartInteractive) {
          hitArea.setAttribute('aria-valuenow', selectionState.index + 1);
          hitArea.setAttribute('aria-valuetext', `${label}: ${times}, ${spokenDuration(duration)} ${night ? 'nighttime' : 'daylight'}${difference ? `, ${spokenDuration(difference)} compared with the current ${night ? 'night' : 'day'}` : ''}`);
        }
        const x = xFor(selectionState.index);
        cursor.setAttribute('x1', x);
        cursor.setAttribute('x2', x);
        cursor.setAttribute('visibility', !isPreview() || selectionState.index === todayIndex ? 'hidden' : 'visible');

        marker.replaceChildren();
        const dateAnchor = x < left + 90 ? 'start' : x > width - right - 90 ? 'end' : 'middle';
        const dateLabel = svgElement('text', { x, y: height - 8, 'text-anchor': dateAnchor, class: 'point-label chart-date' }, label);
        marker.append(dateLabel);
        if (isPreview()) {
          const topDateLabel = svgElement('text', { x, y: top - 6, 'text-anchor': 'middle', class: 'point-label chart-date chart-date-top' }, label);
          marker.append(topDateLabel);
          // Keep the label centered until its painted bounds reach the chart edge.
          // Hidden SVGs can lack a measurable box during the initial render.
          const style = getComputedStyle(topDateLabel);
          const outline = parseFloat(style.strokeWidth) || 0;
          let textBox;
          try { textBox = topDateLabel.getBBox(); } catch { /* Use an estimate until the chart is visible. */ }
          const halfWidth = label.length * (parseFloat(style.fontSize) || 13) * 0.65 / 2;
          const textLeft = textBox?.width ? textBox.x : x - halfWidth;
          const textRight = textBox?.width ? textBox.x + textBox.width : x + halfWidth;
          const shift = Math.max(0, outline - textLeft) - Math.max(0, textRight + outline - width);
          topDateLabel.setAttribute('x', x + shift);
        }
        // Hide month labels that would overlap the selected date.
        function labelBounds(text) {
          const fontSize = parseFloat(getComputedStyle(text).fontSize) || 13;
          const textWidth = text.textContent.length * fontSize * 0.65;
          const anchor = text.getAttribute('text-anchor');
          const position = Number(text.getAttribute('x'));
          const start = position - (anchor === 'end' ? textWidth : anchor === 'middle' ? textWidth / 2 : 0);
          return { start, end: start + textWidth };
        }
        const dateBounds = labelBounds(dateLabel);
        for (const monthLabel of monthLabels) {
          const monthBounds = labelBounds(monthLabel);
          const obscured = monthBounds.end + 4 >= dateBounds.start && monthBounds.start - 4 <= dateBounds.end;
          monthLabel.classList.toggle('is-obscured', obscured);
          if (obscured) monthLabel.setAttribute('aria-hidden', 'true');
          else monthLabel.removeAttribute('aria-hidden');
        }
        const point = points[selectionState.index];
        const labelX = Math.max(left + 45, Math.min(width - right - 45, x));
        if (point) {
          for (const key of ['sunrise', 'sunset']) {
            if (point[key] === null) continue;
            const y = yFor(point[key]);
            const above = key === upperKey ? y - top >= 28 : top + plotHeight - y < 28;
            marker.append(svgElement('circle', { cx: x, cy: y, r: 4, class: `chart-point ${key}-point` }));
            const timestamp = night ? (key === 'sunset' ? period.start : period.end) : day[key];
            chartTimeBadge(marker, labelX, y + (above ? -17 : 17), 'middle', formatTime(timestamp, timeZone), 'point-label', { left, right: width - right });
          }
        }
        const completePoint = point && point.sunrise !== null && point.sunset !== null;
        const durationY = completePoint && point[upperKey] <= point[lowerKey]
          ? (yFor(point[upperKey]) + yFor(point[lowerKey])) / 2
          : top + plotHeight / 2;
        const narrowBand = completePoint && Math.abs(yFor(point.sunrise) - yFor(point.sunset)) < 28;
        const durationAnchor = narrowBand ? (x > left + plotWidth / 2 ? 'end' : 'start') : 'middle';
        const durationX = narrowBand ? x + (durationAnchor === 'end' ? -10 : 10) : labelX;
        const durationText = `${duration}${difference ? ` (${difference})` : ''}`;
        chartTimeBadge(marker, durationX, durationY, durationAnchor, durationText, 'point-label daylight-label', { left, right: width - right });
      }
      resetChartSelection = () => {
        if (version !== renderVersion || !isPreview()) return;
        const from = xFor(selectionState.index);
        selectionState.mode = 'current';
        selectionState.index = currentIndex;
        selectionState.source = undefined;
        selectDay(selectionState.index);
        if (from === currentX || reducedMotion.matches) return;
        cursor.setAttribute('x1', from);
        cursor.setAttribute('x2', from);
        cursor.setAttribute('visibility', 'visible');
        const started = performance.now();
        const frame = (time) => {
          const progress = Math.min(1, Math.max(0, (time - started) / RETURN_DURATION));
          const x = from + (currentX - from) * easeOutCubic(progress);
          cursor.setAttribute('x1', x);
          cursor.setAttribute('x2', x);
          if (progress < 1) chartReturn.frame = requestAnimationFrame(frame);
          else {
            cursor.setAttribute('visibility', 'hidden');
            chartReturn = undefined;
          }
        };
        chartReturn = { cursor, target: currentX, frame: requestAnimationFrame(frame) };
      };
      selectDay(selectionState.index);
      if (chartInteractive) {
        function selectPointerDay(event) {
          selectionState.mode = 'preview';
          selectionState.source = 'pointer';
          const bounds = chart.getBoundingClientRect();
          const x = (event.clientX - bounds.left) * width / bounds.width;
          selectDay(Math.round((x - left) / plotWidth * (days.length - 1)));
        }
        hitArea.addEventListener('pointermove', selectPointerDay);
        hitArea.addEventListener('pointerdown', selectPointerDay);
        hitArea.addEventListener('pointerleave', (event) => { if (event.pointerType === 'mouse' && selectionState.source === 'pointer') resetChartSelection(); });
        hitArea.addEventListener('focus', () => {
          if (restoringFocus) return;
          if (!isPreview()) selectionState.source = 'keyboard';
          selectionState.mode = 'preview';
          selectDay(selectionState.index);
        });
        hitArea.addEventListener('blur', resetChartSelection);
        hitArea.addEventListener('keydown', (event) => {
          let next = selectionState.index;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next--;
          else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next++;
          else if (event.key === 'Home') next = 0;
          else if (event.key === 'End') next = days.length - 1;
          else return;
          event.preventDefault();
          selectionState.mode = 'preview';
          selectionState.source = 'keyboard';
          selectDay(next);
        });
      }
      if (chartInteractive && focused) {
        restoringFocus = true;
        hitArea.focus({ preventScroll: true });
        restoringFocus = false;
      }
      redrawChart = () => renderChart({ focused: document.activeElement === hitArea });
    }

    updateChartToggle();
    $('chart-toggle').addEventListener('click', () => {
      if (chartInteractive) resetChartSelection?.();
      chartInteractive = !chartInteractive;
      updateChartToggle();
      redrawChart?.();
    });
    new ResizeObserver(() => redrawChart?.()).observe($('chart-wrap'));

    document.addEventListener('pointerdown', (event) => {
      if (event.isPrimary && !chart.contains(event.target)) {
        outsidePointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      }
    });
    document.addEventListener('pointerup', (event) => {
      if (outsidePointer?.id !== event.pointerId) return;
      if (Math.hypot(event.clientX - outsidePointer.x, event.clientY - outsidePointer.y) < 10) resetChartSelection?.();
      outsidePointer = undefined;
    });
    document.addEventListener('pointercancel', (event) => {
      if (outsidePointer?.id === event.pointerId) outsidePointer = undefined;
    });
    reducedMotion.addEventListener('change', () => {
      if (reducedMotion.matches) stopChartReturn();
    });

    return {
      setMode(night) {
        const changed = chartNight !== night;
        chartNight = night;
        updateChartDescription();
        if (changed) redrawChart?.();
      },
      setData(nextDays, nextToday, nextTimeZone, nextFollowingDay = null) {
        days = nextDays;
        today = nextToday;
        timeZone = nextTimeZone;
        followingDay = nextFollowingDay;
        selectionState.mode = 'current';
        selectionState.index = null;
        selectionState.source = undefined;
        renderChart();
      },
      redraw() { redrawChart?.(); },
      reset() { resetChartSelection?.(); },
      clear() {
        ++renderVersion;
        stopChartReturn();
        resetChartSelection = undefined;
        redrawChart = undefined;
        selectionState.mode = 'current';
        selectionState.index = null;
        selectionState.source = undefined;
        days = today = timeZone = followingDay = undefined;
        outsidePointer = undefined;
        chart.replaceChildren();
      },
      isPreview
    };
  }
};
