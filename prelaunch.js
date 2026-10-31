// prelaunch.js — one switch for the pre-launch waitlist.
//
// While PRELAUNCH is true, the public can't start a story: every "start" link on
// the homepage opens the waitlist signup, and the intake pages send visitors back
// to it. Testers get the full flow by opening any page once with ?tester=1
// (remembered in this browser); ?tester=0 undoes it.
//
// Testers see a small "Tester mode" badge in the bottom-left corner.
//
// Launch day: set PRELAUNCH to false and deploy.
(function () {
  var PRELAUNCH = true;

  var t = new URLSearchParams(location.search).get('tester');
  try {
    if (t === '1') localStorage.setItem('gm_tester', '1');
    else if (t === '0') localStorage.removeItem('gm_tester');
  } catch (e) {}

  var isTester = false;
  try { isTester = localStorage.getItem('gm_tester') === '1'; } catch (e) {}

  window.GM_WAITLIST_MODE = PRELAUNCH && !isTester;

  // Tester mode banner: a small badge on every page so testers (and you) can
  // see which mode this browser is in, with a one-click way out.
  if (PRELAUNCH && isTester) {
    var showBanner = function () {
      if (document.getElementById('gm-tester-banner')) return;
      var b = document.createElement('div');
      b.id = 'gm-tester-banner';
      b.setAttribute('role', 'status');
      b.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;display:flex;align-items:center;gap:10px;' +
        'padding:8px 14px;border-radius:999px;background:#5c3d2e;color:#fff;font:700 13px/1.2 Nunito,system-ui,sans-serif;' +
        'box-shadow:0 4px 14px rgba(0,0,0,.25);';
      b.innerHTML = '<span>🧪 Tester mode</span>' +
        '<a href="/?tester=0" style="color:#f9c74f;text-decoration:underline">Exit</a>';
      document.body.appendChild(b);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showBanner);
    else showBanner();
  }
})();
