'use strict';

(function () {
  function createPeriodView() {
    const {
      formatDate,
      formatTime,
      formatDuration,
      spokenDuration,
      hasSunEvents,
      sunIsUp
    } = window.DaylightSolar;
    const $ = (id) => document.getElementById(id);
    const periodVisual = document.querySelector('.period-visual');
    const periodFill = document.querySelector('.period-fill');
    const periodCurve = document.querySelector('.period-curve');
    const periodMarker = $('period-marker');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const RETURN_DURATION = 180;
    const easeOutCubic = (progress) => 1 - (1 - progress) ** 3;
    const periodArcState = {
      width: null,
      targetWidth: null,
      frame: undefined,
      hasEndpoints: undefined,
      isPreview: undefined,
      geometry: {
        start: undefined,
        end: undefined,
        visualWidth: undefined,
        durationWidth: undefined
      }
    };

    // Animate one width so the SVG and HTML overlays always share the same geometry.
    function drawPeriodArc(width) {
      periodArcState.width = width;
      const startX = 350 - width / 2, endX = 350 + width / 2;
      const path = `M${startX} 118 Q350 -60 ${endX} 118`;
      periodFill.setAttribute('d', `${path} Z`);
      periodCurve.setAttribute('d', path);
      periodVisual.style.setProperty('--period-start-x', `${startX / 7}%`);
      periodVisual.style.setProperty('--period-end-x', `${endX / 7}%`);
      periodVisual.classList.toggle('is-narrow', width / 700 * periodArcState.geometry.visualWidth < periodArcState.geometry.durationWidth + 16);
      if (!periodMarker.hidden) {
        const progress = Math.max(0, Math.min(1, (Date.now() / 1000 - periodArcState.geometry.start) / (periodArcState.geometry.end - periodArcState.geometry.start)));
        // The quadratic Bézier has a linear x coordinate and a fixed height.
        periodMarker.style.left = `${(startX + width * progress) / 7}%`;
        periodMarker.style.top = `${(118 - 356 * progress * (1 - progress)) / 1.5}%`;
      }
    }

    function stopPeriodAnimation() {
      if (periodArcState.frame !== undefined) cancelAnimationFrame(periodArcState.frame);
      periodArcState.frame = undefined;
    }

    function setPeriodWidth(width, hasEndpoints, preview) {
      const returningFromPreview = periodArcState.isPreview && !preview;
      // Scrubbing follows the chart immediately; only the return to the current period animates.
      // Loading, unavailable events and continuous polar periods are distinct states.
      const snap = preview || periodArcState.width === null || periodArcState.hasEndpoints !== hasEndpoints || reducedMotion.matches ||
        (!returningFromPreview && width !== periodArcState.targetWidth);
      periodArcState.hasEndpoints = hasEndpoints;
      periodArcState.isPreview = preview;
      if (snap) {
        stopPeriodAnimation();
        periodArcState.targetWidth = width;
        drawPeriodArc(width);
      } else if (width === periodArcState.targetWidth) {
        // Clock ticks and pointer moves within the same date must not restart the animation.
        drawPeriodArc(periodArcState.width);
      } else {
        stopPeriodAnimation();
        periodArcState.targetWidth = width;
        if (width === periodArcState.width) { drawPeriodArc(width); return; }
        const from = periodArcState.width, started = performance.now();
        const frame = (time) => {
          const progress = Math.min(1, Math.max(0, (time - started) / RETURN_DURATION));
          drawPeriodArc(from + (width - from) * easeOutCubic(progress));
          periodArcState.frame = progress < 1 ? requestAnimationFrame(frame) : undefined;
        };
        periodArcState.frame = requestAnimationFrame(frame);
        drawPeriodArc(periodArcState.width);
      }
    }

    reducedMotion.addEventListener('change', () => {
      if (!reducedMotion.matches) return;
      if (periodArcState.frame !== undefined) {
        stopPeriodAnimation();
        drawPeriodArc(periodArcState.targetWidth);
      }
    });

    // The arc shows elapsed time, not the sun's actual altitude.
    function update(day, previousDay, nextDay, timeZone, preview = false, nightPreview = null) {
      const hasEvents = hasSunEvents(day);
      const isPartial = day?.duration === null;
      const hasDay = hasEvents && day.sunrise < day.sunset;
      const now = Date.now() / 1000;
      const isBeforeSunrise = hasDay && now < day.sunrise;
      const isNight = preview ? Boolean(nightPreview) : sunIsUp(day, now) === false;
      // Before sunrise, use the night currently ending; after sunset, use tonight.
      const nightStart = nightPreview ? nightPreview.start : isBeforeSunrise ? previousDay?.sunset : day?.sunset;
      const nightEnd = nightPreview ? nightPreview.end : isBeforeSunrise ? day?.sunrise : nextDay?.sunrise;
      const hasNight = (nightPreview || hasDay) && Number.isFinite(nightStart) && Number.isFinite(nightEnd) && nightEnd > nightStart;
      const start = isNight ? nightStart : day?.sunrise;
      const end = isNight ? nightEnd : day?.sunset;
      const hasPeriod = isNight ? hasNight : hasDay;
      // Continuous daylight or nighttime has a duration but no event endpoints.
      const hasContinuousPeriod = Boolean(!nightPreview && day && !hasEvents && !isPartial && (isNight || day.duration >= 86400));
      const hasArc = hasPeriod || hasContinuousPeriod;
      const marker = periodMarker;
      const visual = periodVisual;

      visual.classList.toggle('is-night', isNight);
      $('period-start-label').textContent = isNight ? 'sunset' : 'sunrise';
      $('period-end-label').textContent = isNight ? 'sunrise' : 'sunset';
      $('period-start-time').textContent = nightPreview ? (Number.isFinite(start) ? formatTime(start, timeZone) : 'No sunset') : !day ? '—' : isPartial ? (Number.isFinite(isNight ? day.sunset : day.sunrise) ? formatTime(isNight ? day.sunset : day.sunrise, timeZone) : isNight ? 'No sunset' : 'No sunrise') : !hasEvents ? (isNight ? 'No sunset' : 'No sunrise') : formatTime(start, timeZone);
      $('period-end-time').textContent = nightPreview ? (Number.isFinite(end) ? formatTime(end, timeZone) : '—') : !day ? '—' : isPartial ? (Number.isFinite(isNight ? day.sunrise : day.sunset) ? formatTime(isNight ? day.sunrise : day.sunset, timeZone) : isNight ? 'No sunrise' : 'No sunset') : !hasEvents ? (isNight ? 'No sunrise' : 'No sunset') : formatTime(end, timeZone);
      const duration = nightPreview ? formatDuration(nightPreview.duration) : !day || isPartial ? '—' : !hasEvents ? formatDuration(preview ? day.duration : 86400)
        : isNight ? (hasNight ? formatDuration(end - start) : '—') : formatDuration(day.duration);
      const canShowElapsed = !preview && Boolean(hasPeriod) && now >= start && now < end;
      const elapsed = canShowElapsed ? Math.floor((now - start) / (end - start) * 100) : null;
      $('duration').textContent = preview ? duration : canShowElapsed ? `${elapsed}%` : '—';
      $('duration').setAttribute('aria-label', `${isNight ? 'nighttime' : 'daylight'}: ${preview ? spokenDuration(duration) : canShowElapsed ? `${elapsed} percent elapsed` : 'elapsed percentage unavailable'}`);
      const state = nightPreview ? (hasNight ? '' : 'unavailable') : !day ? '' : isPartial ? 'one event today' : !hasEvents ? (day.duration <= 0 ? 'polar night' : 'midnight sun')
        : !hasDay ? 'events cross midnight' : isNight && !hasNight ? 'unavailable' : '';
      $('period-state').textContent = canShowElapsed ? 'elapsed' : [day && formatDate(day.date, { month: 'short', day: 'numeric' }), state].filter(Boolean).join(' · ');
      $('period-detail').textContent = isNight && hasNight ? `From sunset at ${formatTime(start, timeZone)} to ${nightPreview ? 'the following' : isBeforeSunrise ? 'today’s' : 'tomorrow’s'} sunrise at ${formatTime(end, timeZone)}.` : '';
      document.querySelectorAll('.period-arc').forEach((arc) => arc.toggleAttribute('hidden', !hasArc));
      $('period-start-point').hidden = $('period-end-point').hidden = !hasPeriod;
      marker.hidden = preview || !hasPeriod || now < start || now >= end;
      if (hasArc) {
        // The arc reaches its maximum width at 18 hours.
        const seconds = hasContinuousPeriod ? 86400 : isNight ? end - start : day.duration;
        const maxMinutes = 18 * 60;
        const width = 440 * Math.min(maxMinutes, Math.max(0, Math.round(seconds / 60))) / maxMinutes;
        periodArcState.geometry.start = start;
        periodArcState.geometry.end = end;
        // Measure once per update, rather than forcing layout on every animation frame.
        periodArcState.geometry.visualWidth = visual.clientWidth;
        periodArcState.geometry.durationWidth = document.querySelector('.period-duration').offsetWidth;
        setPeriodWidth(width, hasPeriod, preview);
      } else {
        stopPeriodAnimation();
        periodArcState.width = periodArcState.targetWidth = null;
        periodArcState.hasEndpoints = periodArcState.isPreview = undefined;
        visual.classList.remove('is-narrow');
      }
    }

    return { update };
  }

  window.DaylightPeriod = { createPeriodView };
})();
