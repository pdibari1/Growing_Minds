// Meta Pixel for Growing Minds (Events Manager: "Growing Minds Website").
//
// Include this at the END of <body>, after the page's own scripts, so any page
// that strips personal details from its URL (confirmation.html, upgrade.html)
// has already done so before PageView reports the address to Meta.
//
// Privacy (see privacy-policy.html §8): no child details ever reach Meta.
// - autoConfig is off, so Meta does not scrape buttons, forms or page text.
// - No advanced matching: no email, name or other user data is passed to init.
// - Pages only send standard events with a dollar value, never story details.
(function () {
  var PIXEL_ID = '2542014622878829';

  !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
  n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
  n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
  document,'script','https://connect.facebook.net/en_US/fbevents.js');

  fbq('set', 'autoConfig', false, PIXEL_ID);
  fbq('init', PIXEL_ID);
  fbq('track', 'PageView');
})();
