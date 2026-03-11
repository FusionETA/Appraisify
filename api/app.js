/**
 * Appraisify – App Handler (Vercel Serverless Function)
 *
 * Why this exists:
 * Bitrix24 opens the app "Handler path" using an HTML form POST on every launch,
 * passing auth parameters (DOMAIN, APP_SID, LANG, etc.) in the request body.
 * Vercel's static file serving returns 405 for POST requests.
 * This serverless function accepts GET or POST.
 *
 * IMPORTANT: Bitrix24 requires BX24.init() to be called in the handler response
 * to complete the auth handshake. If init() is never called, Bitrix24 retries
 * the POST, causing a redirect loop. So we load the SDK, call BX24.init(),
 * then navigate to the actual app.
 *
 * Register this directly in Bitrix24 as the Handler path:
 *   https://appraisify-ten.vercel.app/api/app
 */
export default function handler(req, res) {
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', 'frame-ancestors *');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Loading Appraisify\u2026</title>
  <script src="//api.bitrix24.com/api/v1/"></script>
</head>
<body>
  <script>
    function goTo(dest) {
      window.location.replace(dest + window.location.search);
    }

    if (typeof BX24 !== 'undefined') {
      BX24.init(function () {
        // BX24.appOption is portal-wide shared storage (set when admin completes wizard).
        // localStorage is a per-browser fallback.
        var setupDone =
          (BX24.appOption && BX24.appOption.get('setup_done')) ||
          localStorage.getItem('appraisify_setup_done');

        if (setupDone) {
          goTo('/views/dashboard.html');
          return;
        }

        // Setup not yet done — only the installing admin should see the welcome wizard.
        // Non-admins go straight to dashboard (wizard will appear once admin completes it).
        BX24.callMethod('user.admin', {}, function (result) {
          var isAdmin = !result.error() && result.data() === true;
          goTo(isAdmin ? '/views/welcome.html' : '/views/dashboard.html');
        });
      });
    } else {
      // Outside Bitrix24 (e.g. direct browser access) – use localStorage only.
      var setupDone = localStorage.getItem('appraisify_setup_done');
      goTo(setupDone ? '/views/dashboard.html' : '/views/welcome.html');
    }
  </script>
</body>
</html>`);
}
