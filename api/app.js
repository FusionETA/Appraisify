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

        // Check admin status — needed for routing and for deciding whether to refresh the OAuth token.
        BX24.callMethod('user.admin', {}, function (result) {
          var isAdmin = !result.error() && result.data() === true;

          // Only re-store the OAuth token when the current user is an admin.
          // The system token is used by /api/bx-proxy for all privileged CRM calls
          // (crm.deal.list, getDeal, updateDeal) and must belong to an account with
          // CRM "See All" + "Edit All" access. Storing a regular employee's token
          // here would overwrite the admin token and break all system calls.
          if (isAdmin) {
            var auth = BX24.getAuth();
            if (auth && auth.access_token) {
              fetch('/api/store-auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  access_token:  auth.access_token,
                  refresh_token: auth.refresh_token,
                  domain:        auth.domain,
                  member_id:     auth.member_id,
                }),
              }).catch(function () {}); // fire-and-forget, never block navigation
            }
          }

          var dest = (!setupDone && isAdmin) ? '/views/welcome.html' : '/views/dashboard.html';

          // Check for a pending deeplink stored when a notification was sent.
          // If found, navigate directly to the target appraisal and clear the option.
          BX24.callMethod('user.current', {}, function (meResult) {
            try {
              var userId = !meResult.error() && meResult.data() && meResult.data().ID;
              var PAGE = { reviewee: '/views/appraisal-reviewee.html', reviewer: '/views/appraisal-reviewer.html', partner: '/views/appraisal-partner.html' };
              var raw = userId && BX24.appOption && BX24.appOption.get('deeplink_' + userId);
              if (raw) {
                var dl = JSON.parse(raw);
                var page = dl && dl.appraisal && dl.view && PAGE[dl.view];
                if (page) {
                  BX24.appOption.set({ ['deeplink_' + userId]: '' });
                  window.location.replace(page + '?appraisal=' + encodeURIComponent(dl.appraisal));
                  return;
                }
              }
            } catch (_) {}
            goTo(dest);
          });
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
