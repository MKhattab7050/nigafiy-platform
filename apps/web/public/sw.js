// Nigafiy service worker (UX review item 11): push notifications only.
//
// There is deliberately NO fetch handler and no cache: every page and API call goes to the network as
// before, so sign-in, sign-out and the boot flow never see a stale or cached copy. The worker exists so
// the browser can deliver push messages (encrypted by the server, RFC 8291) and run their buttons.
//
// A message is JSON from apps/api/src/modules/notifications/webpush.ts (PushMessage):
//   { title, body, url, tag, severity, lang, actions: [{ id, title, token?, path? }], done: {...} }
// A button with a token POSTs /api/v1/notification-actions/<token> (single use, 24 h); no cookie is
// needed, the token is the authority. Other buttons and a tap on the notification open the page.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const ICON = '/icons/icon-192.png';

self.addEventListener('push', (event) => {
  let msg;
  try {
    msg = event.data ? event.data.json() : null;
  } catch {
    msg = null;
  }
  if (!msg || typeof msg.title !== 'string') {
    msg = { title: 'Nigafiy', body: '', url: '/', tag: 'nigafiy', actions: [], lang: 'en' };
  }
  const actions = Array.isArray(msg.actions) ? msg.actions.slice(0, 2) : [];
  event.waitUntil(
    self.registration.showNotification(msg.title, {
      body: msg.body || '',
      icon: ICON,
      badge: ICON,
      tag: msg.tag || undefined,
      renotify: Boolean(msg.tag),
      requireInteraction: msg.severity === 'critical',
      lang: msg.lang === 'ar' ? 'ar' : 'en',
      dir: msg.lang === 'ar' ? 'rtl' : 'ltr',
      data: { url: typeof msg.url === 'string' ? msg.url : '/', actions, done: msg.done || {}, lang: msg.lang },
      actions: actions.map((a) => ({ action: a.id, title: a.title })),
    }),
  );
});

/** Only same-origin paths are opened. */
function safePath(path) {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') ? path : '/';
}

async function openPage(path) {
  const url = new URL(safePath(path), self.location.origin).href;
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const w of windows) {
    if (new URL(w.url).origin === self.location.origin && 'focus' in w) {
      await w.focus();
      if ('navigate' in w) await w.navigate(url).catch(() => undefined);
      return;
    }
  }
  await self.clients.openWindow(url);
}

async function runAction(button, data) {
  const done = data.done || {};
  const kind = String(button.id || '').replace(/-\d+$/, '');
  let ok = false;
  try {
    const res = await fetch(`/api/v1/notification-actions/${encodeURIComponent(button.token)}`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'X-LD-CSRF': '1' },
    });
    ok = res.ok;
  } catch {
    ok = false;
  }
  await self.registration.showNotification('Nigafiy', {
    body: ok ? done[kind] || 'Done.' : done.failed || 'That did not work. Open Nigafiy to try again.',
    icon: ICON,
    badge: ICON,
    tag: `done-${button.token.slice(0, 8)}`,
    lang: data.lang === 'ar' ? 'ar' : 'en',
    dir: data.lang === 'ar' ? 'rtl' : 'ltr',
    data: { url: data.url, actions: [], done: {} },
  });
  if (!ok) await openPage(data.url);
}

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {};
  event.notification.close();
  const button = (data.actions || []).find((a) => a.id === event.action);
  if (button?.token) {
    event.waitUntil(runAction(button, data));
    return;
  }
  event.waitUntil(openPage(button?.path ? button.path : data.url));
});

// The browser replaced the subscription (keys rotated or expired): register the new one while the
// session cookie is still valid, and forget the old one. If it fails, Settings shows push as off.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const options = event.oldSubscription ? event.oldSubscription.options : null;
      const sub = event.newSubscription || (options ? await self.registration.pushManager.subscribe(options) : null);
      if (!sub) return;
      const json = sub.toJSON();
      const language = (self.navigator.language || '').toLowerCase().startsWith('ar') ? 'ar' : 'en';
      await fetch('/api/v1/notifications/push/subscriptions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-LD-CSRF': '1' },
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, language }),
      }).catch(() => undefined);
      if (event.oldSubscription) {
        await fetch('/api/v1/notifications/push/unsubscribe', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-LD-CSRF': '1' },
          body: JSON.stringify({ endpoint: event.oldSubscription.endpoint }),
        }).catch(() => undefined);
      }
    })(),
  );
});
