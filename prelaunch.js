// prelaunch.js — one switch for the pre-launch waitlist.
//
// While PRELAUNCH is true, the public can't start a story: every "start" link on
// the homepage opens the waitlist signup, and the intake pages send visitors back
// to it. Testers get the full flow by opening any page once with ?tester=1
// (remembered in this browser); ?tester=0 undoes it.
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
})();
