/* ============================================================================
 * Service Worker — Quran Recitation Coach (sw.js)
 * © 2025 Quran Recitation Coach. All rights reserved.
 * ============================================================================ */

const CACHE_VERSION   = 'qc-v1';
const STATIC_CACHE    = `${CACHE_VERSION}-static`;
const API_CACHE       = `${CACHE_VERSION}-api`;
const AUDIO_CACHE     = 'qc-audio'; // Matches AUDIO_CACHE_NAME in index.html

const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json'
];

// External APIs & CDNs that the app relies on
const API_HOSTS = [
  'api.alquran.cloud',
  'api.quran.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

const AUDIO_HOSTS = [
  'everyayah.com',
  'cdn.islamic.network'
];

// ── Install: Pre-cache core app shell ────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
      .catch((err) => console.warn('[SW] Pre-cache warning:', err))
  );
});

// ── Activate: Clean up outdated static/API caches (preserve qc-audio) ────────
self.addEventListener('activate', (event) => {
  const allowedCaches = new Set([STATIC_CACHE, API_CACHE, AUDIO_CACHE]);
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.map((key) => {
          if (!allowedCaches.has(key)) {
            return caches.delete(key);
          }
        })
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: Intelligent routing per resource type ─────────────────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Ignore non-HTTP(S) schemes (e.g., chrome-extension://)
  if (!url.protocol.startsWith('http')) return;

  // 1. Audio files (everyayah.com & cdn.islamic.network) -> Cache-First
  if (AUDIO_HOSTS.some((host) => url.hostname.endsWith(host)) || url.pathname.endsWith('.mp3')) {
    event.respondWith(handleAudioRequest(req));
    return;
  }

  // 2. Quran APIs & Google Fonts -> Stale-While-Revalidate
  if (API_HOSTS.some((host) => url.hostname.endsWith(host))) {
    event.respondWith(handleApiRequest(req));
    return;
  }

  // 3. Same-origin app shell & navigation -> Network-First with Offline Fallback
  if (url.origin === self.location.origin) {
    event.respondWith(handleAppShellRequest(req));
    return;
  }
});

/**
 * Cache-First for Quran recitation & translation MP3s.
 * Supports Safari/Chrome HTTP Range requests for cached audio blobs.
 */
async function handleAudioRequest(request) {
  const cache = await caches.open(AUDIO_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true, ignoreVary: true });

  if (cached) {
    // Handle byte-range requests cleanly if the browser asks for partial content
    if (request.headers.has('range') && cached.type !== 'opaque') {
      return createRangeResponse(request, cached);
    }
    return cached;
  }

  try {
    const networkResponse = await fetch(request);
    // Cache full 200 responses (or opaque cross-origin audio responses)
    if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
      cache.put(request, networkResponse.clone()).catch(() => {});
    }
    return networkResponse;
  } catch (err) {
    return new Response('Offline audio unavailable', {
      status: 503,
      statusText: 'Service Unavailable'
    });
  }
}

/**
 * Slices a cached audio Response to satisfy HTTP Range requests (e.g., iOS Safari).
 */
async function createRangeResponse(request, cachedResponse) {
  try {
    const rangeHeader = request.headers.get('range');
    const buf = await cachedResponse.arrayBuffer();
    const total = buf.byteLength;
    const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);

    if (!match) return cachedResponse;

    const start = Number(match[1]);
    const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;

    if (start >= total || start > end) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${total}` }
      });
    }

    const sliced = buf.slice(start, end + 1);
    return new Response(sliced, {
      status: 206,
      statusText: 'Partial Content',
      headers: {
        'Content-Type': cachedResponse.headers.get('Content-Type') || 'audio/mpeg',
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': String(sliced.byteLength),
        'Accept-Ranges': 'bytes'
      }
    });
  } catch (e) {
    return cachedResponse;
  }
}

/**
 * Stale-While-Revalidate for Quran text, Tajweed metadata, translations & fonts.
 */
async function handleApiRequest(request) {
  const cache = await caches.open(API_CACHE);
  const cached = await cache.match(request);

  const networkFetch = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    return cached;
  }

  const fresh = await networkFetch;
  if (fresh) return fresh;

  return new Response(JSON.stringify({ code: 503, status: 'Offline', data: null }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Network-First for HTML & local static assets so updates deploy immediately,
 * falling back to cached index.html when offline.
 */
async function handleAppShellRequest(request) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok) {
      cache.put(request, networkResponse.clone()).catch(() => {});
    }
    return networkResponse;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;

    if (request.mode === 'navigate') {
      const fallback = await cache.match('./index.html') || await cache.match('./');
      if (fallback) return fallback;
    }

    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

// ── Push Notifications (matches VAPID subscription in index.html) ────────────
self.addEventListener('push', (event) => {
  let payload = {
    title: 'Quran Recitation Coach',
    body: 'Time for your daily Quran recitation or prayer reminder.',
    url: './'
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      payload = Object.assign(payload, parsed);
    } catch (e) {
      const text = event.data.text();
      if (text) payload.body = text;
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag || 'quran-coach-reminder',
      renotify: true,
      data: { url: payload.url || './' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
