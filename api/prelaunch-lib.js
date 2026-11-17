// api/prelaunch-lib.js — server-side half of the pre-launch gate.
//
// prelaunch.js (the client-side file) only redirects the UI — it has no way
// to stop a direct request to an order-creation endpoint (curl, devtools, an
// old bookmarked link straight to intake-form.html). This is the actual
// enforcement: call isPrelaunchBlocked(req) at the top of any endpoint that
// creates a real order or a real preview, before doing anything else.
//
// Two independent flags, kept manually in sync (see the Vercel env var
// PRELAUNCH and the client-side PRELAUNCH constant in prelaunch.js) — not a
// single source of truth, since prelaunch.js is a static file with no access
// to server env vars. LAUNCH DAY: flip BOTH (this env var to "false" AND the
// constant in prelaunch.js) and redeploy — flipping only one leaves the UI
// and the backend disagreeing about whether ordering is open.
//
// Tester bypass: prelaunch.js sets a gm_tester=1 cookie (not just
// localStorage, which never reaches the server) whenever a browser is in
// tester mode, so this can honor the exact same bypass server-side.
function isPrelaunchBlocked(req) {
  if ((process.env.PRELAUNCH || "").toLowerCase() !== "true") return false;
  const cookie = req.headers.cookie || "";
  const isTester = /(?:^|;\s*)gm_tester=1(?:;|$)/.test(cookie);
  return !isTester;
}

module.exports = { isPrelaunchBlocked };
