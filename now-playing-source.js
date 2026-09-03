/* ────────────────────────────────────────────────────────────────────────
   now-playing-source.js — shared data source for the now-playing widgets.

   Reads settings.txt (next to the HTML file) to decide where track info
   comes from:

     source=auto     use Spotify Web API if credentials work, else Snip files
     source=spotify  Spotify Web API only
     source=snip     Snip files only (same as no settings.txt at all)

   Widgets call:

     NowPlayingSource.start(function (track) {
       // track = { title, artist, album, artSrc, playing, placeholder }
       //   artSrc      https URL (Spotify) or blob URL (Snip artwork), or
       //               null when the track has no artwork: clear the image.
       //   playing     false while paused, stopped, or idle.
       //   placeholder true for the "Nothing playing" state.
     });

   Spotify refresh tokens are single-use: every refresh returns a new one.
   The newest token (and the current access token) is kept in localStorage
   so the next refresh, the next OBS start, and other widgets in the same
   OBS all keep working from one settings.txt. Pasting a new token into
   settings.txt starts a fresh chain.

   Works on file:// inside OBS's browser source (XHR with status 0).
   ──────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var SETTINGS_FILE = 'settings.txt';
  var SNIP_TXT      = 'Snip/Snip.txt';
  var SNIP_ART      = 'Snip/Snip_artwork.jpg';
  var TOKEN_URL     = 'https://accounts.spotify.com/api/token';
  var PLAYER_URL    = 'https://api.spotify.com/v1/me/player/currently-playing?additional_types=track,episode';
  var STORE_KEY     = 'now-playing-spotify-auth';

  var REQUEST_TIMEOUT_MS = 10000; // give up on a Spotify request after this long
  var SPOTIFY_RETRY_MS   = 30000; // how long to back off after repeated failures
  var PLACEHOLDER_MS     = 3000;  // show the placeholder if nothing answers by then
  var IDLE_TICKS         = 3;     // "nothing playing" polls before switching to the placeholder
  var MIN_ART_WIDTH      = 160;   // smallest Spotify cover that still looks sharp in a widget
  var RATE_LIMIT_MIN_MS  = 30000; // first wait after a 429 (Retry-After is not readable from a browser)
  var RATE_LIMIT_MAX_MS  = 600000; // longest wait between attempts while rate limited

  var settings = {
    source: 'auto',
    spotify_client_id: '',
    spotify_refresh_token: '',
    poll_interval: 2000,
  };

  var callback  = null;
  var lastTrack = null;
  var settingsLoaded = false;   // settings.txt was found (even if empty)
  var settingsError  = '';      // e.g. saved as UTF-16 by Notepad

  /* Spotify state */
  var refreshToken     = '';     // newest refresh token (rotates on every refresh)
  var accessToken      = null;
  var staleAccessToken = null;   // token that just got a 401: never reuse it from storage
  var refreshing       = false;
  var polling          = false;
  var spotifyFails     = 0;
  var spotifyDeadUntil = 0;      // retry Spotify after this (repeated failures)
  var spotifyWaitUntil = 0;      // don't poll before this (429 rate limit)
  var rateLimitMs      = 0;      // current 429 wait; doubles while the limit persists
  var instanceId       = Math.random().toString(36).slice(2);   // this widget, for shared polling
  var spotifyIdleTicks = 0;
  var spotifyError     = '';     // last hard failure, shown in the placeholder while nothing plays

  /* Snip state */
  var lastSnipRaw   = null;
  var snipTrack     = null;      // last track emitted from Snip; artwork is patched in later
  var snipArtKey    = null;      // fingerprint of the artwork file currently shown
  var snipBlobUrl   = null;
  var snipArtBusy   = false;
  var snipIdleTicks = 0;

  /* ── small helpers ──────────────────────────────────────────────────── */

  // Local file / URL fetch. `ok` is true when the request completed with
  // status 200 (http) or 0 (file:// in OBS). A missing file fires onerror.
  function xhrGet(url, opts, done) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    if (opts.mime) xhr.overrideMimeType(opts.mime);
    if (opts.responseType) xhr.responseType = opts.responseType;
    xhr.onload  = function () { done(xhr.status === 200 || xhr.status === 0, xhr); };
    xhr.onerror = function () { done(false, xhr); };
    try { xhr.send(); } catch (e) { done(false, xhr); }
  }

  function emit(track) {
    lastTrack = track;
    if (callback) callback(track);
  }

  function emitPlaceholder(reason) {
    emit({ title: 'Nothing playing', artist: reason || '', album: '',
           artSrc: null, playing: false, placeholder: true });
  }

  // Called by a source that is reachable but has nothing to show. If a real
  // track is on screen it stays and is marked paused after IDLE_TICKS polls:
  // Spotify answers 204 once a paused device goes inactive, and Snip blanks
  // its file while paused, so "Nothing playing" would be wrong there. The
  // placeholder is only used while no track has been shown yet.
  function idle(ticks) {
    if (lastTrack && !lastTrack.placeholder) {
      if (ticks >= IDLE_TICKS && lastTrack.playing) {
        lastTrack.playing = false;
        emit(lastTrack);
      }
      return;
    }
    var idleShown = lastTrack && !lastTrack.artist;   // blank-reason placeholder already up
    if (!idleShown) emitPlaceholder('');
  }

  function placeholderReason() {
    if (settingsError) return settingsError;
    if (settings.source === 'snip') return 'Snip not detected';
    if (!spotifyConfigured()) {
      if (settings.source === 'spotify') return 'Spotify not configured';
      return settingsLoaded ? 'Snip not detected' : 'No settings.txt and no Snip files';
    }
    if (spotifyError) return spotifyError;
    return settings.source === 'spotify' ? 'Spotify not detected' : 'No source detected';
  }

  // A Spotify failure that will not fix itself by retrying (account not
  // allowed to use the app, login expired): remember the reason, back off,
  // and show it right away unless a real track is already on screen.
  function spotifyFailed(reason) {
    spotifyError = reason;
    markSpotifyDown();
    if (!lastTrack || lastTrack.placeholder) emitPlaceholder(reason);
  }

  /* ── settings.txt ───────────────────────────────────────────────────── */

  function loadSettings(done) {
    xhrGet(SETTINGS_FILE, { mime: 'text/plain; charset=utf-8' }, function (ok, xhr) {
      if (ok) settingsLoaded = true;
      if (ok && xhr.responseText) {
        // A UTF-16 file (Notepad's "Unicode") decodes to text full of NUL bytes.
        if (xhr.responseText.indexOf('\u0000') !== -1) settingsError = 'settings.txt must be saved as UTF-8';
        xhr.responseText.split('\n').forEach(function (line) {
          line = line.trim();
          if (!line || line.charAt(0) === '#') return;
          var eq = line.indexOf('=');
          if (eq === -1) return;
          var key = line.slice(0, eq).trim().toLowerCase();
          var val = line.slice(eq + 1).replace(/\s#.*$/, '').trim();   // " # comment" after a value
          if (key === 'poll_interval') {
            var n = parseInt(val, 10);
            if (n >= 500) settings.poll_interval = n;                 // floor: 500 ms
          } else if (key === 'source') {
            val = val.toLowerCase();
            if (val === 'auto' || val === 'spotify' || val === 'snip') settings.source = val;
          } else if (Object.prototype.hasOwnProperty.call(settings, key)) {
            settings[key] = val;
          }
        });
      }
      done();
    });
  }

  function spotifyConfigured() {
    return !!(settings.spotify_client_id && settings.spotify_refresh_token);
  }

  /* ── token storage (shared by every widget in the same OBS) ─────────── */

  // One stored chain per settings.txt token: a freshly pasted token starts a
  // new chain, and switching settings.txt back (say, after trying a friend's
  // file) finds the previous chain untouched.
  function storeKey() {
    return STORE_KEY + ':' + settings.spotify_refresh_token;
  }

  function readStore() {
    try {
      var s = JSON.parse(localStorage.getItem(storeKey()));
      return (s && s.seed === settings.spotify_refresh_token) ? s : null;
    } catch (e) { return null; }
  }

  function writeStore(fields) {
    var s = readStore() || { seed: settings.spotify_refresh_token };
    for (var k in fields) {
      if (Object.prototype.hasOwnProperty.call(fields, k)) s[k] = fields[k];
    }
    try { localStorage.setItem(storeKey(), JSON.stringify(s)); } catch (e) { /* storage unavailable */ }
  }

  function markSpotifyDown() {
    // Back off, then try again. Never give up permanently, so the widget
    // recovers when Spotify or the network comes up later.
    spotifyDeadUntil = Date.now() + SPOTIFY_RETRY_MS;
    spotifyFails     = 0;
    spotifyIdleTicks = 0;
    accessToken      = null;
    lastSnipRaw      = null;   // re-read Snip from scratch so the fallback shows the current track
  }

  /* ── Spotify Web API ────────────────────────────────────────────────── */

  function refreshAccessToken(done) {
    if (refreshing) return;

    // Another widget in this OBS may already have refreshed: reuse its tokens.
    var stored = readStore();
    if (stored && stored.access_token && stored.access_token !== staleAccessToken &&
        stored.expires_at > Date.now() + 30000) {
      accessToken  = stored.access_token;
      spotifyFails = 0;
      if (done) done(true);
      return;
    }
    if (stored && stored.refresh_token) refreshToken = stored.refresh_token;
    var usedToken = refreshToken;

    refreshing = true;
    var xhr = new XMLHttpRequest();
    xhr.open('POST', TOKEN_URL, true);
    xhr.timeout = REQUEST_TIMEOUT_MS;
    xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      refreshing = false;
      var data = null;
      if (xhr.status === 200) {
        try { data = JSON.parse(xhr.responseText); } catch (e) { /* malformed */ }
      }
      if (data && data.access_token) {
        accessToken      = data.access_token;
        staleAccessToken = null;
        spotifyFails     = 0;
        // Spotify rotates refresh tokens (each is single-use): keep the newest.
        if (data.refresh_token) refreshToken = data.refresh_token;
        writeStore({
          refresh_token: refreshToken,
          access_token:  accessToken,
          expires_at:    Date.now() + (data.expires_in || 3600) * 1000,
        });
        if (done) done(true);
        return;
      }
      accessToken = null;
      var err = null;
      if (xhr.status === 400) {
        try { err = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
      }
      if (err && err.error === 'invalid_grant') {
        var s2 = readStore();
        if (s2 && s2.refresh_token && s2.refresh_token !== usedToken) {
          // Another widget rotated the token while this refresh was in
          // flight; the next tick picks up its tokens from storage.
        } else {
          // Expired (6 months), revoked, or already used from another copy
          // of settings.txt: only a new login fixes this.
          spotifyFailed('Spotify login expired: re-run spotify-setup.html');
        }
      } else if (err && err.error) {
        spotifyFailed('Spotify: ' + (err.error_description || err.error));   // e.g. wrong client id
      } else {
        spotifyFails++;
        if (spotifyFails >= 3) {
          spotifyFailed(xhr.status ? 'Spotify login failed (HTTP ' + xhr.status + ')' : 'Spotify unreachable');
        }
      }
      if (done) done(false);
    };
    try {
      xhr.send(
        'grant_type=refresh_token' +
        '&refresh_token=' + encodeURIComponent(refreshToken) +
        '&client_id=' + encodeURIComponent(settings.spotify_client_id)
      );
    } catch (e) {
      refreshing = false;
      spotifyFails++;
      if (done) done(false);
    }
  }

  // Spotify lists covers largest first (640 / 300 / 64). Use the smallest one
  // that is still sharp in a widget, or the largest available if none is.
  function pickImage(images) {
    var pick = null;
    (images || []).forEach(function (im) {
      if (!im || !im.url) return;
      var w = im.width || 0, pw = pick ? (pick.width || 0) : 0;
      var sharp = w >= MIN_ART_WIDTH, pickSharp = pw >= MIN_ART_WIDTH;
      if (!pick || (sharp && (!pickSharp || w < pw)) || (!sharp && !pickSharp && w > pw)) pick = im;
    });
    return pick ? pick.url : null;
  }

  function spotifyTrack(data) {
    var item = data.item;
    var artist = item.artists
      ? item.artists.map(function (a) { return a.name; }).join(', ')
      : (item.show ? item.show.name : '');            // podcast episode
    return {
      title:   item.name || '',
      artist:  artist,
      album:   item.album ? item.album.name : (item.show ? item.show.name : ''),
      artSrc:  pickImage((item.album && item.album.images) || item.images),
      playing: !!data.is_playing,
    };
  }

  /* ── shared polling: several widgets in one OBS make one request ────── */

  // Rate limits are per app, so widgets in the same OBS share the last player
  // answer through localStorage. Whoever polled last keeps polling; the others
  // reuse its answer and only take over when it stops updating.
  function playerKey() {
    return STORE_KEY + ':player:' + settings.spotify_refresh_token;
  }

  function readPlayer() {
    try { return JSON.parse(localStorage.getItem(playerKey())) || null; } catch (e) { return null; }
  }

  function writePlayer(fields) {
    var p = readPlayer() || {};
    for (var k in fields) {
      if (Object.prototype.hasOwnProperty.call(fields, k)) p[k] = fields[k];
    }
    try { localStorage.setItem(playerKey(), JSON.stringify(p)); } catch (e) { /* storage unavailable */ }
  }

  // A 429 seen by any widget parks all of them.
  function syncSharedWait() {
    var shared = readPlayer();
    if (shared && shared.waitUntil > spotifyWaitUntil) spotifyWaitUntil = shared.waitUntil;
    return shared;
  }

  function pollSpotify() {
    var shared = syncSharedWait();
    if (Date.now() < spotifyWaitUntil) return;
    if (!accessToken) {
      // Poll as soon as a token is available rather than waiting a tick.
      refreshAccessToken(function (ok) { if (ok) pollSpotify(); });
      return;
    }
    if (shared && shared.owner && shared.owner !== instanceId &&
        Date.now() - shared.at < settings.poll_interval * 1.5) {
      handlePlayerResponse(shared.status, shared.text, null);   // reuse the other widget's answer
      return;
    }
    if (polling) return;
    polling = true;
    var xhr = new XMLHttpRequest();
    xhr.open('GET', PLAYER_URL, true);
    xhr.timeout = REQUEST_TIMEOUT_MS;
    xhr.setRequestHeader('Authorization', 'Bearer ' + accessToken);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      polling = false;
      if (xhr.status === 200 || xhr.status === 204) {
        writePlayer({ owner: instanceId, at: Date.now(), status: xhr.status,
                      text: xhr.status === 200 ? xhr.responseText : '' });
      }
      handlePlayerResponse(xhr.status, xhr.responseText, xhr);
    };
    try { xhr.send(); } catch (e) { polling = false; spotifyFails++; }
  }

  function handlePlayerResponse(status, text, xhr) {
    if (status === 200 && text) {
      spotifyFails = 0;
      spotifyError = '';
      rateLimitMs  = 0;
      var data = null;
      try { data = JSON.parse(text); } catch (e) { /* malformed */ }
      if (data && data.item) {
        spotifyIdleTicks = 0;
        emit(spotifyTrack(data));
      } else {
        idle(++spotifyIdleTicks);            // ad break or unknown item type
      }
    } else if (status === 204) {
      spotifyFails = 0;                      // reachable, nothing playing
      spotifyError = '';
      rateLimitMs  = 0;
      idle(++spotifyIdleTicks);
    } else if (status === 403) {
      // A development-mode app only serves accounts the owner listed under
      // User Management in the Developer Dashboard.
      var msg = '';
      try { msg = JSON.parse(text).error.message || ''; } catch (e) { /* no body */ }
      spotifyFailed(/not registered/i.test(msg)
        ? 'Spotify: this account is not added to the app'
        : 'Spotify: ' + (msg || 'access denied'));
    } else if (status === 401) {
      staleAccessToken = accessToken;        // expired: refresh on next tick
      accessToken = null;
    } else if (status === 429) {
      rateLimited(xhr);
    } else {
      spotifyFails++;
      if (spotifyFails >= 5) {
        spotifyFailed(status ? 'Spotify error (HTTP ' + status + ')' : 'Spotify unreachable');
      }
    }
  }

  // Spotify limits requests per app over a rolling 30 s window. Browsers cannot
  // read its Retry-After header (Spotify does not expose it to scripts), so
  // wait in growing steps instead, and make every widget in this OBS wait too.
  function rateLimited(xhr) {
    var header = xhr ? parseInt(xhr.getResponseHeader('Retry-After'), 10) : 0;
    var waitMs = header > 0 ? header * 1000
               : rateLimitMs ? Math.min(rateLimitMs * 2, RATE_LIMIT_MAX_MS) : RATE_LIMIT_MIN_MS;
    rateLimitMs      = waitMs;
    spotifyWaitUntil = Date.now() + waitMs;
    spotifyIdleTicks = 0;
    lastSnipRaw      = null;                 // let Snip take over meanwhile
    writePlayer({ waitUntil: spotifyWaitUntil });
    var reason = 'Spotify rate limited, retrying in ' +
      (waitMs < 60000 ? Math.round(waitMs / 1000) + ' s' : Math.round(waitMs / 60000) + ' min');
    spotifyError = reason;
    if (!lastTrack || lastTrack.placeholder) emitPlaceholder(reason);
  }

  /* ── Snip files ─────────────────────────────────────────────────────── */

  function parseSnip(raw) {
    var lines = raw.trim().split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!lines.length) return null;
    if (lines.length >= 2) return { title: lines[0], artist: lines[1] };
    var dash = lines[0].indexOf(' - ');
    if (dash !== -1) return { artist: lines[0].slice(0, dash), title: lines[0].slice(dash + 3) };
    return { title: lines[0], artist: '' };
  }

  // Cheap fingerprint so the artwork is only re-sent when the file changes.
  function fingerprint(buf) {
    var bytes = new Uint8Array(buf), h = 0;
    for (var i = 0; i < bytes.length; i += 61) h = (h * 31 + bytes[i]) >>> 0;
    return bytes.length + ':' + h;
  }

  // Snip writes Snip.txt first and the artwork a moment later, so the
  // artwork is re-checked on every poll and swapped in whenever it changes.
  function pollSnipArtwork() {
    if (snipArtBusy) return;
    snipArtBusy = true;
    var track = snipTrack;
    xhrGet(SNIP_ART, { responseType: 'arraybuffer' }, function (ok, xhr) {
      snipArtBusy = false;
      var buf = ok ? xhr.response : null;
      if (!buf || !buf.byteLength || track !== snipTrack) return;
      var key = fingerprint(buf);
      if (key === snipArtKey) return;
      snipArtKey = key;
      var url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
      var old = snipBlobUrl;
      snipBlobUrl = url;
      track.artSrc = url;
      emit(track);
      if (old) URL.revokeObjectURL(old);
    });
  }

  function pollSnip() {
    xhrGet(SNIP_TXT, { mime: 'text/plain; charset=utf-8' }, function (ok, xhr) {
      var raw = ok ? xhr.responseText : '';
      if (!raw.trim()) {
        // Missing file: keep what is shown (the startup placeholder explains
        // "Snip not detected"). Empty file: Snip is running but paused/stopped.
        if (ok) idle(++snipIdleTicks);
        return;
      }
      snipIdleTicks = 0;
      if (raw !== lastSnipRaw) {
        lastSnipRaw = raw;
        var t = parseSnip(raw);
        if (!t) return;
        snipTrack  = { title: t.title, artist: t.artist, album: '', artSrc: null, playing: true };
        snipArtKey = null;                   // new track: always re-send the artwork
        emit(snipTrack);
      } else if (snipTrack && (lastTrack !== snipTrack || !snipTrack.playing)) {
        // Same track back after a pause (or after Spotify was the source):
        // show it as playing again, keeping the artwork it already has.
        snipTrack.playing = true;
        emit(snipTrack);
      }
      if (snipTrack) pollSnipArtwork();
    });
  }

  /* ── main loop ──────────────────────────────────────────────────────── */

  function tick() {
    var wantSpotify = spotifyConfigured() && settings.source !== 'snip';
    if (wantSpotify) syncSharedWait();
    var now = Date.now();
    if (wantSpotify && now >= spotifyDeadUntil && now >= spotifyWaitUntil) pollSpotify();
    else if (settings.source !== 'spotify') pollSnip();
  }

  window.NowPlayingSource = {
    start: function (cb) {
      callback = cb;
      // If no source produces data shortly after startup, show a
      // "not running" placeholder instead of staying invisible.
      setTimeout(function () {
        if (!lastTrack) emitPlaceholder(placeholderReason());
      }, PLACEHOLDER_MS);
      loadSettings(function () {
        refreshToken = settings.spotify_refresh_token;
        if (spotifyConfigured() && settings.source !== 'snip') {
          refreshAccessToken(function (ok) {
            if (ok) pollSpotify();
            else if (settings.source === 'auto') pollSnip();   // fall back without waiting a tick
          });
        } else {
          tick();
        }
        setInterval(tick, settings.poll_interval);
      });
    },
    getLastTrack: function () { return lastTrack; },
  };
}());
