'use strict';

(() => {
  const key = 'daylight-theme';
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  const themeColor = document.querySelector('meta[name="theme-color"]');
  const validTheme = (value) => value === 'light' || value === 'dark' ? value : null;
  let preference = null;
  try { preference = validTheme(localStorage.getItem(key)); } catch { /* Storage can be unavailable. */ }

  function applyTheme() {
    const theme = preference || (systemTheme.matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = theme;
    themeColor.content = theme === 'dark' ? '#121518' : '#f9f9f9';
    const button = document.getElementById('theme-toggle');
    if (button) {
      const label = `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`;
      button.setAttribute('aria-label', label);
      button.title = label;
    }
  }

  // Run in the head, before the stylesheet and first paint.
  applyTheme();
  systemTheme.addEventListener('change', () => { if (!preference) applyTheme(); });
  window.addEventListener('storage', (event) => {
    if (event.key === key || event.key === null) {
      preference = validTheme(event.key === null ? null : event.newValue);
      applyTheme();
    }
  });
  document.addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('theme-toggle');
    button.addEventListener('click', () => {
      preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(key, preference); } catch { /* Keep the choice for this page. */ }
      applyTheme();
    });
    applyTheme();
  });
})();
