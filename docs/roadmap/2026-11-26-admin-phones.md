# Admin phones (2026-11-26)

Owner request: when a phone is connected in Fleet, choose **admin** or **regular user**. An admin
phone has every permission: the Nigafiy dashboard (Fleet included, so the computers can be
controlled from the phone) inside the phone app, and alerts when the network has a real problem.

Owner's decisions (memory: admin-phone-decisions):

1. Fleet on the phone is the **full web dashboard inside the app** (a WebView). Native screens for
   the most-used things come later.
2. **The choice in Fleet is enough.** No sign-in on the phone. Whoever holds the unlocked phone has
   full control, so Fleet marks admin phones clearly and revoking one is one click.
3. Alerts: **important problems only.**
   - What counts: internet down, the router or an important device offline, an unknown device
     joining, and security problems.
   - Each one alerts once, and again when it is resolved.

## Design

### Roles

- `endpoints.phone_role`: `user` (default, today's behaviour) or `admin`. Only Android endpoints.
- Only an organization admin can create an admin phone, or turn a phone into one.
- The phone acts as **the admin who made it admin**: `endpoints.phone_admin_user_id`.
- Its dashboard session has that user's role. If that user loses the admin role or is deactivated,
  the session stops working: membership is re-checked on every request, as for every session.
- Audit: every action the dashboard takes is that user's, with the session's user agent
  "Nigafiy phone (<endpoint name>)".
- Turning a phone back into `user`, or revoking it, ends its dashboard sessions at once.

### Dashboard on the phone

- The web app listens on 127.0.0.1 only. The API's LAN HTTPS listener (the one the phone already
  uses, built-in LAN TLS) also serves the dashboard pages, proxied to the local web server, **only to
  a request that carries a valid admin-phone session**. Everyone else gets 404 there, as today.
- Away from home the dashboard works through the owner's existing outside access (Tailscale).
- `POST /api/v1/agent/dashboard-session` (agent credential): for an admin phone, creates a normal web
  session for `phone_admin_user_id`, tied to the endpoint (`sessions.endpoint_id`). It returns the
  cookie value, which the app puts into the WebView's cookie store; it is never shown.
- The WebView trusts only the server certificate the app already pins (same pin check as the
  agent). A certificate error for anything else is refused.
- The LAN origin `https://<server>:47143` is accepted by the CSRF Origin check only for sessions
  with an `endpoint_id`.

### Alerts on the phone

- The notifications module already decides what is important and sends it to channels (email,
  Telegram, ntfy, web push).
- Admin phones become one more delivery target: important incidents (opened and resolved) are
  queued per admin phone and handed over on the agent's next poll or hub message.
- The app shows them as Android notifications in a "Network alerts" channel. Tapping one opens that
  page of the dashboard in the app.
- Quiet hours and the calm-alerts rules apply, as for the other channels.

### Phone app

- An admin phone gets a 4th tab, **Dashboard** (the WebView), and the Home tab shows the latest
  alerts.
- A regular phone is unchanged.
- The app learns its role from the heartbeat reply (`phone_role`) and redraws.

### Fleet

- "Connect a phone" asks: **Regular user** (default) or **Admin**. The Admin option is shown only to
  admins, with one line saying what it gives.
- The phone's card shows an "Admin phone" badge.
- Its menu has "Make regular user" / "Make admin" and Revoke.

## Stages

1. Server: migration (`phone_role`, `phone_admin_user_id`, `sessions.endpoint_id`), Fleet API to
   set the role, heartbeat reply, dashboard-session route, tests.
2. Server: dashboard proxy on the LAN HTTPS listener for admin-phone sessions only; Origin rule;
   tests.
3. Alerts: queue per admin phone, delivery on poll and hub, resolved alerts; tests.
4. Fleet web UI: the choice when connecting, badge, menu (EN + AR).
5. Phone app: Dashboard tab (WebView with the pin), alerts as notifications, Home alerts card.
6. Release 1.0.6 (asked first), install, try it end to end on the A36.
