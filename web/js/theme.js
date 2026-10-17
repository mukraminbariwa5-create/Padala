// Appearance, applied before the page is drawn (loaded in <head>), so it never flashes the wrong theme.
// Choice: 'light' (the default) or 'dark'. Stored on this device.
(function () {
  var root = document.documentElement;
  function choice() { try { return localStorage.getItem('padala.theme') === 'dark' ? 'dark' : 'light'; } catch (e) { return 'light'; } }
  function apply() {
    var c = choice();
    var theme = c;
    root.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#f4f6f5' : '#0a0e0d');
    var scheme = document.querySelector('meta[name="color-scheme"]');
    if (scheme) scheme.setAttribute('content', theme);
  }
  apply();
  window.padalaTheme = {
    get: choice,
    set: function (c) { try { localStorage.setItem('padala.theme', c); } catch (e) { /* storage off */ } apply(); },
  };
})();
