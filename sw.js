/* ============================================================
   Quran Recitation Coach — Service Worker
   ============================================================
   v79 — SW-only version bump matching the current index.html.
         No routing change, no API change, no cache-key change,
         no strategy change. The one behavioural change this
         release tracks lives entirely in the client:

           O. PHONEME (Wav2Vec2) ENGINE REMOVED FROM THE CLIENT.
              The recitation pipeline in index.html now reads:

                  ASR → MFA → RMS

              (previously: ASR → RMS → Phoneme → MFA).

              Why the Phoneme engine was removed:
                • Its PHON map collapsed every emphatic letter
                  into its plain counterpart (ص→س, ط→ت, ق→ك,
                  ح→ه …) BEFORE comparison. Heavy/light
                  substitutions — the very errors the engine
                  claimed to detect — became invisible.
                • Its acceptance threshold was identical to
                  isMatchWord (which already runs at Priority
                  1), so it almost never fired.
                • It bypassed runStrict1Checks, silently
                  marking a word as correct without running any
                  Tajweed verification. That is the opposite of
                  what Tajweed mode needs.

           P. MFA ENGINE RE-CALIBRATED AND REORDERED.
              runMFAInference now uses the reciter's measured
              pace (getBaseMsPerLetter(), falling back to
              110 ms/letter while the pace samples warm up)
              instead of a hard-coded 110 ms. Its transcript
              tolerance is one step LOOSER than ASR
              (toleranceFor(L) + 1) so it can actually rescue
              partially-mispronounced words — previously it
              was stricter than ASR on long words and could
              never fire. In both modes MFA now runs BEFORE
              RMS (was: RMS before MFA).

           Q. TAJWEED CHECKS NOW RUN ON EVERY SUCCESS PATH.
              ASR, MFA and RMS each call runStrict1Checks after
              commitCorrect. A misread word is followed by a
              non-timing Tajweed sweep
              (runStrict1Checks(ptr-1, heard,
                                 { skipTiming: true,
                                   breakChain: true }))
              so each rule the word also violated is recorded
              as its own mistakes-list row. markStrict1Error
              uses a per-word Set (w._tajweedErrs) instead of
              the old `error`-class guard so different rules
              can each fire once per word, and resetProgress()
              clears that Set so a fresh session re-evaluates
              every word.

           None of these touch the SW. The only thing this
           worker does for v71 is bump the version string so
           activate() sweeps qc-*-v70 and older. qc-audio
           (downloaded Quran MP3s) is preserved — every release
           has preserved it, and the safety contract below
           requires that this one does too.

   ============================================================
   USER-DATA SAFETY CONTRACT  (read before editing this file)
   ============================================================
   This service worker MUST NEVER delete, evict, or overwrite:

     1. USER-AUTHORED STATE
        – Recitation progress, streaks, achievements
        – Prayer-time settings, location, madhab, calculation
          method, athaan audio choice, notification prefs
        – Bookmarks, last-read position, mushaf page, hifz
          test state
        – Translation choice, reciter choice, UI prefs
        All of the above live in localStorage / IndexedDB /
        cookies, which a service worker has NO API to delete.
        This SW never sends Clear-Site-Data, never calls
        indexedDB.deleteDatabase(), and never touches
        localStorage (which is not even exposed to SW scope).

     2. DOWNLOADED QURAN AUDIO  (qc-audio)
        Hundreds of MB of everyayah.com MP3s, produced by many
        minutes of the user's bandwidth and battery. qc-audio
        is in PERSISTENT_CACHES and is therefore:
          • SKIPPED by activate()'s stale-cache sweep
          • NEVER touched by trimCache() (which only runs on
            TEXT_CACHE and RUNTIME_CACHE)
          • NEVER written by any fetch handler — the SW only
            reads it; the client is the sole writer
          • PRESERVED by CLEAR_CACHES unless the caller passes
            includeAudio: true
          • Only ever removed by the dedicated CLEAR_AUDIO_CACHE
            message, which the client must gate behind an
            explicit "Delete all downloads" confirm dialog.

     3. ANYTHING WE DIDN'T CREATE
        The activate sweep deletes a cache ONLY when ALL THREE
        are true: (a) its name starts with one of OWNED_PREFIXES,
        (b) it is not in VERSIONED_CACHES, and (c) it is not in
        PERSISTENT_CACHES. A cache created by another app on
        the same origin, or a future cache we haven't registered
        yet, is left alone. Deleting a cache we don't recognize
        violates this contract.

   ============================================================
   PREVIOUS RELEASES (kept for context — all still accurate)
   ============================================================

   v70 — SW-only user-data-safety release. No routing change,
         no API change, no cache-key change, no strategy change.
         One behavioural fix + explicit safety docs:
           L. CLEAR_CACHES NO LONGER WIPES DOWNLOADED AUDIO
              BY DEFAULT. The message handler now deletes only
              non-persistent caches unless the client passes
              includeAudio: true.
           M. USER-DATA SAFETY CONTRACT DOCUMENTED IN HEADER.
           N. activate() CACHE FILTER REWRITTEN WITH EXPLICIT
              BRANCH COMMENTS.
         Client-side: v70 paired with the v68 multi-engine
         recitation pipeline (ASR → RMS → Phoneme Wav2Vec2 →
         MFA).

   v69 — SW-only hardening: offline reinstall no longer wipes
         the shell (falls back to previous qc-shell-* cache when
         network fetch fails during install); same fallback for
         fonts; install-time shell fetches get an 8 s timeout;
         serveRangeFromCached() preserves cached MIME type.
           H. Offline reinstall shell fallback.
           I. Offline reinstall fonts fallback.
           J. Install-time shell fetch timeout.
           K. Range 206 preserves cached Content-Type.

   v68 — SW-only version bump. Shell-navigation and shell-install
         both still use cache:'reload', so the new index.html
         reaches the client on the next online navigation after
         the v68 worker activates.
         THE CLIENT-SIDE CHANGE THAT PROMPTED THAT BUMP:
         index.html introduced the (now-superseded) asynchronous
         multi-engine recitation pipeline:
           • Phoneme Recognition (Wav2Vec2)
           • Forced Alignment (MFA)
         Priority cascade at that time in gradeFull / gradeFollowOnly:
           1. ASR Match (Instant)
           2. RMS Acoustic Match (Instant)
           3. Phoneme (Wav2Vec2) & MFA (Asynchronous Fallback)
           4. Wait / Skip
         SW-side impact of v68: none. Superseded by v71 (below),
         which removed the Phoneme engine and reordered the
         remaining cascade to ASR → MFA → RMS.

   v67 — SW-only version bump for THREE FOLLOW-UP FIXES (E, F, G)
         to the Follow-mode recitation path, layered on top of
         the four v66 fixes (A, B, C, D).
           E. Follow-mode fuzzy rescue of the CURRENT word now
              fires BEFORE the lookahead.
           F. Follow-mode lookahead fires ONLY on an EXACT match.
           G. Even with an exact match on words[ptr+1], the
              pointer does NOT skip if the token could also
              plausibly be the current word.

   v66 — SW-only version bump for the initial Follow-mode fixes
         A/B/C/D:
           A. markSkippedWord() returns immediately when
              followOnly is true.
           B. isPlausiblePronunciationAttempt() — removed the
              dead `return false;` at the top.
           C. gradeFull() — Follow mode capped to 1-word lookahead.
           D. Call-site guard on the 4-token flush branch.

   v65 — SW-only bugfix to networkFresh(). Paginated Tajweed
         responses are now matched on their EXACT URL on offline
         fallback (was ignoreSearch:true, which collided every
         page for a given chapter onto a single key).

   v64 — Bugfix-only release matching the current index.html:
           • MADD / GHUNNAH-LENGTH TIMING FIX.
           • RETARGETED isEndOfAyah to `!nextW || nextW.verse !== w.verse`.
           • RAISED END_OF_AYAH_MADD_MIN_MS 150 → 250 ms.
           • SWAPPED #tajweedStatusChip / #tajweedNoiseChip.
           • REMOVED dead code.

   WHAT IS ACTUALLY SHIPPED IN THE CURRENT index.html
   (this is the source of truth this SW must match):
     • Copyright + AI policy:
         – <meta name="copyright"> and <meta name="rights"> tags.
         – Per-bot <meta name="GPTBot" ...> etc. for 20+ AI crawlers.
         – Pre-body JS blocker that whitelists Googlebot, Bingbot,
           Vercel analytics, DuckDuckBot, Slurp, Applebot.
         – A full-screen #aiBlockOverlay shown to blocked crawlers.
       COPYRIGHT POLICY IS INTENTIONALLY HIDDEN FROM THE UI:
         – No UI affordance opens it. The only way to read the
           policy is to view source.
     • Recitation Coach — Multi-Engine Pipeline:
         ASR (Instant) → MFA (Forced Alignment) → RMS Acoustic.
         If ANY engine marks the word correct, the word turns
         green AND runStrict1Checks runs on that word in Tajweed
         mode. Follow mode uses a 1-word exact lookahead and
         never invokes the (removed) Phoneme engine.
     • Tajweed mode — rule-aware checks covering FOUR rules:
         madd duration, ghunnah nasal presence, ghunnah length,
         silent-letter not pronounced. Every success path
         (ASR / MFA / RMS) verifies these rules; a misread word
         is additionally swept for non-timing rule failures.
     • Two English text translations selectable in the UI:
         Abdullah Yusuf Ali · Saheeh International.
     • 20 Qari reciters (RECITER_ORDER).
     • Pace-scaled madd / ghunnah thresholds.
     • Adaptive MIN_RMS recalibration on the RMS analyser.
     • Streak & achievements.
     • Hifz Test (Silent Recall / Reveal-on-Mistake / Blank Last
       Line) with Web Speech API for reveal-on-mistake.
     • Standalone Tajweed Colors screen (Quran.com annotations).
     • Prayer Times + Qibla compass + Athaan audio.
     • Feedback modal → POST /api/feedback.
     • QR code (offline-generated SVG via built-in QRGen).
     • Install prompts (beforeinstallprompt + platform-aware
       instructions modal).
     • Book-form mushaf reader with swipeable pages.
     • Calendar / Hijri dates.
     • Offline downloads with live percentage, cancel / resume,
       persistent via qc-audio (survives every version bump).

   WHY THIS SW DOES *NOT* DO AI-CRAWLER BLOCKING
   ---------------------------------------------
   A service worker can only ever run in a browser that has
   already registered one on a previous visit. AI crawlers
   (GPTBot, CCBot, ClaudeBot, …) never register SWs. AI policy is
   enforced in two layers that are strictly stronger than a SW check:
     1. /robots.txt  — bypassed below so it is never stale.
     2. index.html   — meta tags + pre-body blocker + overlay.

   NOTE ON DEPLOY: after shipping v71, fully close the PWA (or
   close every tab showing the site) and reopen it. The browser
   fetches sw.js on navigation; the new worker's install calls
   skipWaiting() and its activate calls clients.claim(), so the
   next open runs the new code path. Caches qc-*-v70 and older
   are deleted on activate; qc-audio (downloads) is preserved.
   ============================================================ */

'use strict';

const VERSION = 'v71';

const SHELL_CACHE   = `qc-shell-${VERSION}`;
const TEXT_CACHE    = `qc-text-${VERSION}`;
const FONTS_CACHE   = `qc-fonts-${VERSION}`;
const RUNTIME_CACHE = `qc-runtime-${VERSION}`;

const VERSIONED_CACHES = [SHELL_CACHE, TEXT_CACHE, FONTS_CACHE, RUNTIME_CACHE];

/* qc-audio is the ONLY user-owned Cache Storage bucket in this app.
   It must survive every version bump, every CLEAR_CACHES call that
   didn't explicitly ask to wipe it, and every trimCache() pass. */
const AUDIO_CACHE = 'qc-audio';
const PERSISTENT_CACHES = [AUDIO_CACHE];

const OWNED_PREFIXES = ['qc-shell-', 'qc-text-', 'qc-fonts-', 'qc-runtime-'];

const SHELL_URLS = ['./', './index.html', './manifest.json'];

const HOST_ALQURAN              = 'api.alquran.cloud';
const HOST_QURAN_COM            = 'api.quran.com';
const HOST_EVERYAYAH            = 'everyayah.com';
const HOST_GOOGLE_FONTS_CSS     = 'fonts.googleapis.com';
const HOST_GOOGLE_FONTS_STATIC  = 'fonts.gstatic.com';

const TEXT_CACHE_MAX = 400;
const RUNTIME_MAX    = 120;
const MANIFEST_TIMEOUT_MS    = 2000;
const SHELL_FETCH_TIMEOUT_MS = 8000;

/* The exact Google Fonts stylesheet URL used by <link> in index.html.
   Pre-cached during install so the stylesheet is available offline
   on the very first cold open — not just on the second visit. */
const FONT_CSS_URL = 'https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&family=Amiri+Quran&family=Scheherazade+New:wght@400;700&family=Noto+Naskh+Arabic:wght@400;700&display=swap';
const FONT_FETCH_TIMEOUT_MS  = 8000;
const FONTS_PREFETCH_TOTAL_MS = 20000;

/* Inline SVG icon used by push notifications. */
const NOTIFICATION_ICON = "data:image/svg+xml," + encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 180 180'>" +
    "<rect width='180' height='180' rx='40' fill='#000000'/>" +
    "<path d='M90 62 Q58 48 28 50 L28 118 Q58 116 90 130 Z' fill='#F5C542'/>" +
    "<path d='M90 62 Q122 48 152 50 L152 118 Q122 116 90 130 Z' fill='#D9A32B'/>" +
  "</svg>"
);

/* ============================================================
   INSTALL — cache shell + pre-cache Google Fonts
   ============================================================ */
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    // 1. Shell — awaited (mandatory for offline open). If the
    //    network is unreachable (offline update), fall back to
    //    the previous qc-shell-* cache so activate doesn't leave
    //    the new shell empty.
    try{ await cacheShellWithFallback(); }catch(_){}

    // 2. Google Fonts — best-effort, bounded to 20 s so install
    //    can never hang if the network is slow or the CDN is down.
    //    Same offline-update fallback applies.
    try{
      await Promise.race([
        prefetchFontsWithFallback().catch(() => {}),
        new Promise(r => setTimeout(r, FONTS_PREFETCH_TOTAL_MS))
      ]);
    }catch(_){}

    // 3. Activate immediately
    try{ await self.skipWaiting(); }catch(_){}
  })());
});

/* Returns the most recent cache whose name starts with `prefix`
   and is not `excludeName`, or null if none exists. Used by the
   install-time fallbacks. Never matches PERSISTENT_CACHES — the
   prefixes we pass ('qc-shell-', 'qc-fonts-') cannot collide with
   'qc-audio'. */
async function getPreviousCache(prefix, excludeName){
  try{
    const keys = await caches.keys();
    const old = keys.find(k => k.startsWith(prefix) && k !== excludeName);
    if(old) return await caches.open(old);
  }catch(_){}
  return null;
}

/* Populates SHELL_CACHE from the network, falling back to the
   previous qc-shell-* cache for any URL that couldn't be fetched.
   No-op if there is no previous shell cache (first install). */
async function cacheShellWithFallback(){
  const cache = await caches.open(SHELL_CACHE);
  const oldCache = await getPreviousCache('qc-shell-', SHELL_CACHE);

  await Promise.all(SHELL_URLS.map(async url => {
    // Try fresh network first. cache:'reload' guarantees the new
    // worker stores the *new* index.html containing the v71
    // recitation pipeline (ASR → MFA → RMS, Phoneme removed).
    try{
      const res = await fetchWithTimeout(url, SHELL_FETCH_TIMEOUT_MS, { cache: 'reload' });
      if(res && (res.ok || res.type === 'opaque')){
        try{ await cache.put(url, res.clone()); }catch(_){}
        return;
      }
    }catch(_){ /* fall through to previous-cache fallback */ }

    // Offline-update fallback: copy from previous version's shell.
    if(oldCache){
      try{
        let hit = await oldCache.match(url, { ignoreSearch: true });
        // './' and './index.html' both resolve to the same
        // navigation document — accept either key.
        if(!hit){
          if(url === './')                    hit = await oldCache.match('./index.html', { ignoreSearch: true });
          else if(url === './index.html')     hit = await oldCache.match('./',           { ignoreSearch: true });
        }
        if(hit) await cache.put(url, hit);
      }catch(_){}
    }
  }));
}

/* ============================================================
   ACTIVATE — drop every stale versioned cache, claim clients

   SAFETY: this sweep deletes a cache ONLY when ALL THREE hold:
       (a) its name starts with one of OWNED_PREFIXES,
       (b) it is not in VERSIONED_CACHES (current version),
       (c) it is not in PERSISTENT_CACHES (qc-audio = downloads).
   A cache we didn't create, or a cache we've marked persistent,
   is left untouched. See USER-DATA SAFETY CONTRACT in header.
   ============================================================ */
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    try{
      const keys = await caches.keys();
      const toDelete = keys.filter(name => {
        // (a) Caches belonging to other apps on this origin, or a
        //     future cache we haven't registered yet — leave alone.
        if(!OWNED_PREFIXES.some(p => name.startsWith(p))) return false;

        // (b) The current version's caches — obviously keep.
        if(VERSIONED_CACHES.includes(name)) return false;

        // (c) Persistent caches (qc-audio = downloaded Quran MP3s).
        //     Never delete — the user paid real bandwidth for these.
        if(PERSISTENT_CACHES.includes(name)) return false;

        // Stale versioned cache we own and don't need — safe to drop.
        return true;
      });
      await Promise.all(toDelete.map(name => caches.delete(name)));
    }catch(_){}

    if(self.registration && self.registration.navigationPreload){
      try{ await self.registration.navigationPreload.disable(); }catch(_){}
    }
    try{ await self.clients.claim(); }catch(_){}
  })());
});

/* ============================================================
   MESSAGES — SKIP_WAITING / CLEAR_CACHES / CLEAR_AUDIO_CACHE /
              REFRESH_MANIFEST
   ============================================================ */
self.addEventListener('message', event => {
  const data = event.data || {};
  if(data.type === 'SKIP_WAITING'){ self.skipWaiting(); return; }

  if(data.type === 'CLEAR_CACHES'){
    event.waitUntil((async () => {
      // SAFETY: preserve qc-audio (downloaded Quran MP3s) unless the
      // client explicitly asks to wipe it. The client must only pass
      // includeAudio: true from a confirmed "Delete all downloads"
      // user action — never from a generic "reset app" path, and
      // never automatically on a version bump (the activate sweep
      // handles version bumps without touching qc-audio at all).
      const wipeAudio = data.includeAudio === true;
      const keys = await caches.keys();
      const toDelete = keys.filter(k => {
        if(wipeAudio) return true;
        return !PERSISTENT_CACHES.includes(k);
      });
      await Promise.all(toDelete.map(k => caches.delete(k)));
      if(event.source && event.source.postMessage){
        event.source.postMessage({
          type: 'CACHES_CLEARED',
          audioPreserved: !wipeAudio
        });
      }
    })());
    return;
  }

  if(data.type === 'CLEAR_AUDIO_CACHE'){
    // The client is responsible for showing an explicit confirm
    // dialog before posting this message. This is the ONLY code
    // path in the entire SW that removes qc-audio.
    event.waitUntil((async () => {
      try{ await caches.delete(AUDIO_CACHE); }catch(_){}
      if(event.source && event.source.postMessage) event.source.postMessage({ type: 'AUDIO_CACHE_CLEARED' });
    })());
    return;
  }

  if(data.type === 'REFRESH_MANIFEST'){
    event.waitUntil((async () => {
      try{
        const cache = await caches.open(SHELL_CACHE);
        await Promise.all([
          cache.delete('./manifest.json', { ignoreSearch: true }),
          cache.delete('./index.html',    { ignoreSearch: true }),
          cache.delete('./',              { ignoreSearch: true })
        ]);
      }catch(_){}
      if(event.source && event.source.postMessage) event.source.postMessage({ type: 'MANIFEST_REFRESHED' });
    })());
    return;
  }
});

/* ============================================================
   PUSH — show notification with the Recite logo
   ============================================================ */
self.addEventListener('push', event => {
  let data = { title: 'Quran Recitation Coach', body: 'You have a new message.', url: './' };
  try{ if(event.data) data = Object.assign(data, event.data.json()); }catch(_){}
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: NOTIFICATION_ICON,
    badge: NOTIFICATION_ICON,
    tag: data.tag || 'qc-notification',
    renotify: true,
    data: { url: data.url }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil((async () => {
    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for(const c of list){
      if(c.url.startsWith(self.location.origin) && 'focus' in c){
        // Only navigate for SPECIFIC targets (e.g. "open ayah 2:255").
        // Prayer-time notifications fire with no data.url → target
        // defaults to './'. Navigating a focused app to Home on a
        // prayer-alert tap would kill any active recitation session
        // mid-flow. So for the default case, just focus — the app is
        // already where the user wanted to be.
        const isSpecific =
          target &&
          target !== './' &&
          target !== '/' &&
          target !== self.registration.scope;
        if(isSpecific){
          try{ await c.navigate(target); }catch(_){}
        }
        return c.focus();
      }
    }
    if(clients.openWindow) return clients.openWindow(target);
  })());
});

/* ============================================================
   FETCH — strategy dispatch
   ============================================================ */
self.addEventListener('fetch', event => {
  const req = event.request;

  // Only intercept GET. POST / PUT / DELETE — including Vercel Analytics
  // view events, /api/feedback and /api/subscribe — must go straight to
  // the network untouched.
  if(req.method !== 'GET') return;

  let url;
  try{ url = new URL(req.url); }catch(_){ return; }
  if(url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Same-origin paths that must NEVER be intercepted by the SW.
  if(url.origin === self.location.origin){
    if(url.pathname.startsWith('/my-analytics/')) return;   // proxied Vercel Web Analytics
    if(url.pathname.startsWith('/_vercel/'))       return;   // native Vercel Analytics / Speed Insights
    if(url.pathname.startsWith('/api/'))           return;   // serverless functions
    if(url.pathname === '/sw.js')                  return;   // the service worker itself
    // robots.txt is the *only* file that can block Google-Extended and
    // Applebot-Extended (they share their UA with Googlebot / Applebot
    // and are indistinguishable in JS). It must always be served fresh
    // from Vercel, never from any cache — otherwise an updated AI policy
    // would be silently hidden behind a stale copy.
    if(url.pathname === '/robots.txt')             return;
  }

  // Tajweed annotation requests — always try the network first so
  // newly-shipped colour fields are never hidden behind a stale
  // cache. networkFresh() caches successful responses for offline
  // fallback (see its body); if the network fails it will return
  // the last-seen cached version instead of a hard 504.
  if(url.hostname === HOST_QURAN_COM && url.search.includes('text_uthmani_tajweed')){
    event.respondWith(networkFresh(req));
    return;
  }

  // Audio from everyayah.com — served from the persistent download
  // cache first (works fully offline), network second. Respects
  // req.cache ('no-store' / 'reload') so the app's healing path can
  // actually fetch fresh bytes, and answers Range requests with a
  // proper 206 for iOS Safari.
  //
  // SAFETY: audioFromDownloadCache only READS from qc-audio. It never
  // writes, never evicts, never trims. The client is the sole writer
  // of qc-audio (via download code in index.html).
  if(url.hostname === HOST_EVERYAYAH){
    event.respondWith(audioFromDownloadCache(req));
    return;
  }

  // Google Fonts — cache-first, pre-populated at install.
  if(url.hostname === HOST_GOOGLE_FONTS_CSS || url.hostname === HOST_GOOGLE_FONTS_STATIC){
    event.respondWith(cacheFirst(req, FONTS_CACHE));
    return;
  }

  // Quran text APIs — network-first with cache fallback.
  if(url.hostname === HOST_QURAN_COM || url.hostname === HOST_ALQURAN){
    event.respondWith(networkFirst(req, TEXT_CACHE, TEXT_CACHE_MAX));
    return;
  }

  // Same-origin
  if(url.origin === self.location.origin){
    if(url.pathname.endsWith('/manifest.json')){
      event.respondWith(manifestFresh(req));
      return;
    }
    if(req.mode === 'navigate'){
      event.respondWith(shellNavigation(req));
      return;
    }
    event.respondWith(cacheFirst(req, RUNTIME_CACHE, RUNTIME_MAX));
    return;
  }

  // Anything else (cdn.islamic.network audio fallback during download,
  // api.bigdatacloud.net / geocoding-api.open-meteo.com for the Prayer
  // Times screen, islamcan.com adhan fallback) is intentionally left
  // unhandled so it goes to the network normally. Download code in
  // index.html stores fallback audio under the everyayah.com URL, so
  // playback always hits qc-audio regardless of which source succeeded.
});

/* ============================================================
   Audio — persistent download cache with Range + bypass support

   SAFETY: this whole module is READ-ONLY against qc-audio. It never
   cache.put()s, never cache.delete()s, never trims. Downloads are
   written exclusively by the client. That means no version bump and
   no fetch-time code path can ever evict the user's downloaded MP3s.
   ============================================================ */

async function audioFromDownloadCache(req){
  // Respect explicit no-store/reload from the app. This is what makes
  // playTranslationWithHealing() actually able to refresh a broken
  // cached audio file — the heal fetch fires with `cache: 'no-store'`
  // + `?_heal=<ts>`, and without this guard the SW would keep serving
  // the same corrupt bytes from qc-audio, defeating the heal entirely.
  const bypass = req.cache === 'no-store' || req.cache === 'reload';

  if(!bypass){
    try{
      const cache = await caches.open(AUDIO_CACHE);
      const hit = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
      if(hit){
        // <audio> sends `Range: bytes=0-` for media files. Serving the
        // full cached response with a 200 works on Chrome / Firefox,
        // but iOS Safari is strict about receiving a real 206 with a
        // valid Content-Range header. Return a proper 206 slice when
        // the client asked for a range.
        const rangeHeader = req.headers.get('range');
        if(rangeHeader) return serveRangeFromCached(hit, rangeHeader);
        return hit;
      }
    }catch(_){}
  }

  try{
    // Preserve the request's own cache mode (`no-store` / `reload` /
    // `default`) — passing the original Request object to fetch() is
    // sufficient, no need to re-wrap.
    return await fetch(req);
  }catch(_){
    // Network failed. If we bypassed the cache earlier, try it now as
    // a last resort — a slightly-stale file beats a hard 504 when the
    // user is offline mid-playback.
    if(bypass){
      try{
        const cache = await caches.open(AUDIO_CACHE);
        const hit = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
        if(hit) return hit;
      }catch(_){}
    }
    return new Response('', { status: 504, statusText: 'Gateway Timeout' });
  }
}

async function serveRangeFromCached(response, rangeHeader){
  let blob;
  try{ blob = await response.blob(); }
  catch(_){ return response; }

  const size = blob.size;
  if(!size) return response;

  // Preserve the cached Content-Type so the 206 slice matches what
  // was actually stored.
  const mime = response.headers.get('Content-Type') || 'audio/mpeg';

  // Parse the standard byte-range forms: bytes=0-, bytes=N-, bytes=0-N,
  // bytes=-N (suffix range). Unparseable → return full 200.
  const m = /^bytes=(\d*)-(\d*)$/.exec((rangeHeader || '').trim());
  if(!m){
    return new Response(blob, {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(size)
      }
    });
  }

  let start, end;
  if(m[1] === '' && m[2] !== ''){
    // Suffix range: bytes=-N → last N bytes
    const suffix = parseInt(m[2], 10);
    if(!isFinite(suffix) || suffix <= 0) return response;
    start = Math.max(0, size - suffix);
    end   = size - 1;
  } else if(m[1] !== '' && m[2] === ''){
    // Open range: bytes=N- → from N to end
    start = parseInt(m[1], 10);
    end   = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end   = parseInt(m[2], 10);
  }

  if(!isFinite(start) || start < 0) start = 0;
  if(!isFinite(end)   || end >= size) end = size - 1;

  if(start > end){
    return new Response('', {
      status: 416,
      statusText: 'Range Not Satisfiable',
      headers: { 'Content-Range': 'bytes */' + size }
    });
  }

  const slice = blob.slice(start, end + 1, mime);
  return new Response(slice, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': mime,
      'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes'
    }
  });
}

/* ============================================================
   Fetch strategies
   ============================================================ */

async function cacheFirst(req, cacheName, maxEntries){
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if(hit) return hit;
  try{
    const res = await fetch(req);
    if(res && (res.ok || res.type === 'opaque')){
      const clone = res.clone();
      cache.put(req, clone)
        .then(() => { if(maxEntries) trimCache(cacheName, maxEntries); })
        .catch(() => {});
    }
    return res;
  }catch(_){
    return new Response('', { status: 504, statusText: 'Gateway Timeout' });
  }
}

async function networkFirst(req, cacheName, maxEntries){
  const cache = await caches.open(cacheName);
  try{
    const res = await fetch(req);
    if(res && res.ok){
      const clone = res.clone();
      cache.put(req, clone)
        .then(() => { if(maxEntries) trimCache(cacheName, maxEntries); })
        .catch(() => {});
    }
    return res;
  }catch(_){
    const hit = await cache.match(req);
    if(hit) return hit;
    return new Response(
      JSON.stringify({ code: 503, status: 'OFFLINE', data: null }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/* networkFresh — always goes to the network first (bypassing the
   browser HTTP cache entirely). Caches successful responses in
   TEXT_CACHE and falls back to them when the network fails. This
   enables offline Tajweed colouring + rule checks for surahs the
   user has already opened online, while preserving the "always
   fresh when online" guarantee.

   The offline fallback lookup matches on the EXACT URL (including
   pagination query params) so page=2 gets page=2's data, not
   whichever page was cached last. `ignoreVary: true` is kept so
   the lookup still succeeds if the response carried a Vary header
   that differs between the original PUT and this GET.

   SAFETY: this only ever writes/deletes within TEXT_CACHE, never
   within qc-audio. */
async function networkFresh(req){
  try{
    const freshReq = new Request(req, { cache: 'no-store' });
    const res = await fetch(freshReq);
    if(res && res.ok){
      // Cache the successful response for offline fallback
      try{
        const cache = await caches.open(TEXT_CACHE);
        await cache.put(req, res.clone());
        // Cap the cache size — Tajweed surahs count towards the same
        // quota as other Quran API responses. TEXT_CACHE only.
        trimCache(TEXT_CACHE, TEXT_CACHE_MAX).catch(() => {});
      }catch(_){}
      return res;
    }
    throw new Error('bad response');
  }catch(_){
    // Offline / network failure — try the last-seen cached version.
    // Match on the EXACT URL (including pagination query params) so
    // page=2 gets page=2's data, not whichever page was cached last.
    try{
      const cache = await caches.open(TEXT_CACHE);
      const hit = await cache.match(req, { ignoreVary: true });
      if(hit) return hit;
    }catch(_){}
    return new Response('', { status: 504, statusText: 'Gateway Timeout' });
  }
}

async function manifestFresh(req){
  const cache = await caches.open(SHELL_CACHE);

  // 1. Try network with a 2 s budget (manifest changes must reach the
  //    client quickly, but offline must never hang on the request).
  try{
    const controller = new AbortController();
    const timer = setTimeout(() => { try{ controller.abort(); }catch(_){} }, MANIFEST_TIMEOUT_MS);
    let res;
    try{
      res = await fetch(req, { signal: controller.signal, cache: 'no-store' });
    } finally {
      clearTimeout(timer);
    }
    if(res && res.ok){
      const clone = res.clone();
      cache.put('./manifest.json', clone).catch(() => {});
      return res;
    }
    throw new Error('bad response');
  }catch(_){ /* fall through to cache */ }

  // 2. Offline — serve from cache. Try both the canonical key and the
  //    request's own URL, since the navigation may hit either one.
  try{
    let hit = await cache.match('./manifest.json', { ignoreSearch: true });
    if(!hit) hit = await cache.match(req, { ignoreSearch: true });
    if(hit) return hit;
  }catch(_){}

  // 3. Last resort — inline fallback manifest so installation never fails.
  return new Response(
    JSON.stringify({
      name: 'Quran Recitation Coach',
      short_name: 'Recite',
      start_url: './',
      scope: './',
      display: 'standalone',
      background_color: '#0d1119',
      theme_color: '#0d1119',
      icons: []
    }),
    { status: 200, headers: { 'Content-Type': 'application/manifest+json; charset=utf-8' } }
  );
}

async function shellNavigation(req){
  const cache = await caches.open(SHELL_CACHE);
  try{
    // Force a fresh fetch — bypass the browser HTTP cache so a stale
    // index.html can never be served after a deploy. This is what
    // makes "my fix didn't reach the app" impossible even when a
    // network is available but its HTTP cache is warm.
    const freshReq = new Request(req, { cache: 'reload' });
    const res = await fetch(freshReq);
    if(res && res.ok && res.type === 'basic'){
      const clone = res.clone();
      cache.put('./index.html', clone).catch(() => {});
    }
    return res;
  }catch(_){
    let hit = null;
    try{
      hit = await cache.match(req, { ignoreSearch: true })
         || await cache.match('./index.html', { ignoreSearch: true })
         || await cache.match('./', { ignoreSearch: true });
    }catch(_){}
    if(hit) return hit;
    // Offline + no cache — the fallback page. Only real users can
    // ever see this (AI crawlers never register a service worker),
    // so it is safe to include the copyright line here even though
    // the in-app copyright policy UI has been hidden.
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Offline</title>' +
      '<body style="font-family:sans-serif;padding:2rem;text-align:center;background:#0d1119;color:#e8edf7">' +
      '<h2>You are offline</h2>' +
      '<p>Open the app once while online to enable offline mode.</p>' +
      '<p style="font-size:.75rem;opacity:.6;margin-top:2rem">&copy; 2025 Quran Recitation Coach. All rights reserved.</p>',
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

/* SAFETY: trimCache is NEVER called with AUDIO_CACHE. Only
   TEXT_CACHE and RUNTIME_CACHE are trimmed. If you ever add a new
   caller, add a guard: `if (PERSISTENT_CACHES.includes(cacheName)) return;` */
async function trimCache(cacheName, maxEntries){
  if(PERSISTENT_CACHES.includes(cacheName)) return;  // defence-in-depth
  try{
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    const over = keys.length - maxEntries;
    if(over <= 0) return;
    for(let i = 0; i < over; i++) await cache.delete(keys[i]);
  }catch(_){}
}

/* ============================================================
   Google Fonts pre-cache (bounded, best-effort)
   ============================================================ */

async function fetchWithTimeout(input, ms, init){
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try{ ctrl.abort(); }catch(_){} }, ms);
  try{
    return await fetch(input, Object.assign({ signal: ctrl.signal }, init || {}));
  } finally {
    clearTimeout(timer);
  }
}

/* Populates FONTS_CACHE from Google Fonts. If the stylesheet
   fetch fails (or a font file can't be fetched), the entry is
   copied from the previous qc-fonts-* cache when present. */
async function prefetchFontsWithFallback(){
  let cache;
  try{ cache = await caches.open(FONTS_CACHE); }catch(_){ return; }
  const oldCache = await getPreviousCache('qc-fonts-', FONTS_CACHE);

  // 1. Fetch and cache the CSS stylesheet
  let cssText = '';
  try{
    const cssRes = await fetchWithTimeout(FONT_CSS_URL, FONT_FETCH_TIMEOUT_MS, {
      mode: 'cors', credentials: 'omit', cache: 'no-store'
    });
    if(cssRes && cssRes.ok){
      cssText = await cssRes.clone().text();
      try{ await cache.put(FONT_CSS_URL, cssRes); }catch(_){}
    }
  }catch(_){}

  // Offline-update fallback for the stylesheet itself.
  if(!cssText && oldCache){
    try{
      const old = await oldCache.match(FONT_CSS_URL, { ignoreSearch: true });
      if(old){
        cssText = await old.clone().text();
        try{ await cache.put(FONT_CSS_URL, old); }catch(_){}
      }
    }catch(_){}
  }

  if(!cssText) return;

  // 2. Extract every absolute url(...) referenced from the stylesheet
  const urls = [];
  const re = /url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g;
  let m;
  while((m = re.exec(cssText)) !== null){
    const u = m[2];
    if(u && /^https?:\/\//i.test(u)) urls.push(u);
  }

  // 3. Fetch each font file in parallel, skipping ones already cached
  const unique = Array.from(new Set(urls));
  await Promise.all(unique.map(async u => {
    try{
      const existing = await cache.match(u, { ignoreSearch: true });
      if(existing) return;

      // Network first
      try{
        const r = await fetchWithTimeout(u, FONT_FETCH_TIMEOUT_MS, {
          mode: 'cors', credentials: 'omit', cache: 'no-store'
        });
        if(r && (r.ok || r.type === 'opaque')){
          try{ await cache.put(u, r); }catch(_){}
          return;
        }
      }catch(_){}

      // Offline-update fallback: copy from previous fonts cache.
      if(oldCache){
        try{
          const old = await oldCache.match(u, { ignoreSearch: true });
          if(old) await cache.put(u, old);
        }catch(_){}
      }
    }catch(_){}
  }));
}
