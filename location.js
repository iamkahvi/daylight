'use strict';

(function () {
  const DEFAULT_LOCATION = { name: 'Victoria, British Columbia, Canada', lat: 48.4284, lon: -123.3656, tz: 'America/Vancouver' };

  function validLocation(value) {
    if (!Number.isFinite(value.lat) || Math.abs(value.lat) > 90 || !Number.isFinite(value.lon) || Math.abs(value.lon) > 180 || !value.tz) return false;
    try { new Intl.DateTimeFormat('en', { timeZone: value.tz }); return true; } catch { return false; }
  }

  function locationFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const candidate = {
      lat: params.has('lat') && params.get('lat').trim() ? Number(params.get('lat')) : NaN,
      lon: params.has('lon') && params.get('lon').trim() ? Number(params.get('lon')) : NaN,
      tz: params.get('tz'), name: params.get('n') || 'Selected location'
    };
    return validLocation(candidate) ? candidate : { ...DEFAULT_LOCATION };
  }

  function createLocationPicker({ onSelect }) {
    const input = document.getElementById('location-input');
    const clearLocation = document.getElementById('location-clear');
    const locationControl = document.querySelector('.location-control');
    const dropdown = document.getElementById('location-dropdown');
    const state = {
      currentLocation: locationFromUrl(),
      results: [],
      activeIndex: -1,
      debounce: undefined,
      searchVersion: 0,
      uiState: 'closed'
    };

    function renderDropdown() {
      if (state.uiState === 'closed') {
        dropdown.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
        return;
      }

      dropdown.replaceChildren();
      if (state.uiState === 'searching' || state.uiState === 'empty' || state.uiState === 'error') {
        const messages = {
          searching: 'Searching…',
          empty: 'No locations found',
          error: 'Couldn’t search locations. Try again.'
        };
        const message = document.createElement('div');
        message.className = 'location-empty';
        message.textContent = messages[state.uiState];
        dropdown.append(message);
      } else if (state.uiState === 'results') {
        state.results.forEach((result, index) => {
          const option = document.createElement('div');
          option.className = `location-option${index === state.activeIndex ? ' active' : ''}`;
          option.id = `location-option-${index}`;
          option.setAttribute('role', 'option');
          option.setAttribute('aria-selected', String(index === state.activeIndex));
          option.textContent = result.name;
          option.addEventListener('mousedown', (event) => event.preventDefault());
          option.addEventListener('click', () => selectLocation(result));
          dropdown.append(option);
        });
      }

      dropdown.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      if (state.activeIndex >= 0 && state.results[state.activeIndex]) {
        input.setAttribute('aria-activedescendant', `location-option-${state.activeIndex}`);
        dropdown.children[state.activeIndex]?.scrollIntoView({ block: 'nearest' });
      } else input.removeAttribute('aria-activedescendant');
    }

    function setUiState(uiState) {
      state.uiState = uiState;
      renderDropdown();
    }

    function closeDropdown() {
      setUiState('closed');
    }

    async function search(query, version) {
      try {
        const params = new URLSearchParams({ name: query, count: '8', language: 'en', format: 'json' });
        const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`);
        if (!response.ok) throw new Error(`Search returned ${response.status}`);
        const data = await response.json();
        if (version !== state.searchVersion) return;
        state.results = (data.results || []).map((item) => ({ name: [item.name, item.admin1, item.country].filter(Boolean).join(', '), lat: item.latitude, lon: item.longitude, tz: item.timezone || 'GMT' })).filter(validLocation);
        state.activeIndex = -1;
        setUiState(state.results.length ? 'results' : 'empty');
      } catch (error) {
        if (version !== state.searchVersion) return;
        state.results = [];
        state.activeIndex = -1;
        setUiState('error');
      }
    }

    function selectLocation(selected) {
      clearTimeout(state.debounce);
      state.searchVersion++;
      state.results = [];
      state.activeIndex = -1;
      state.currentLocation = selected;
      input.value = selected.name;
      closeDropdown();
      const params = new URLSearchParams(window.location.search);
      for (const [key, value] of Object.entries({ lat: selected.lat, lon: selected.lon, tz: selected.tz, n: selected.name })) params.set(key, value);
      history.pushState(null, '', `${window.location.pathname}?${params}${window.location.hash}`);
      onSelect(selected);
    }

    input.addEventListener('input', () => {
      clearTimeout(state.debounce);
      const version = ++state.searchVersion;
      const query = input.value.trim();
      state.results = [];
      state.activeIndex = -1;
      if (query.length < 2) { closeDropdown(); return; }
      setUiState('searching');
      state.debounce = setTimeout(() => search(query, version), 250);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { clearTimeout(state.debounce); state.searchVersion++; closeDropdown(); input.value = state.currentLocation.name; return; }
      if (dropdown.hidden || !state.results.length) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        state.activeIndex = event.key === 'ArrowDown' ? Math.min(state.activeIndex + 1, state.results.length - 1) : Math.max(state.activeIndex - 1, 0);
        renderDropdown();
      } else if (event.key === 'Enter' && state.activeIndex >= 0) {
        event.preventDefault();
        selectLocation(state.results[state.activeIndex]);
      }
    });
    clearLocation.addEventListener('pointerdown', (event) => event.preventDefault());
    clearLocation.addEventListener('click', () => {
      input.value = '';
      input.focus();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    document.addEventListener('click', (event) => { if (!event.target.closest('.location-control')) { clearTimeout(state.debounce); state.searchVersion++; closeDropdown(); input.value = state.currentLocation.name; } });
    locationControl.addEventListener('focusout', (event) => {
      if (locationControl.contains(event.relatedTarget)) return;
      clearTimeout(state.debounce); state.searchVersion++; closeDropdown(); input.value = state.currentLocation.name;
    });

    input.value = state.currentLocation.name;

    return {
      setLocation(location) {
        clearTimeout(state.debounce);
        state.searchVersion++;
        closeDropdown();
        state.currentLocation = location;
        input.value = state.currentLocation.name;
      }
    };
  }

  window.DaylightLocation = { locationFromUrl, createLocationPicker };
})();
