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
     }, {                                   // optional: a page with several looks
       themes: ['zune', 'spotify', ...],    //   the looks it can show
       defaultTheme: 'zune',
       onTheme: function (name) { ... },    //   called once the look is known, before the first track
     });

   The look (NowPlayingSource.theme) comes from, in this order: ?theme=name
   on the page address, theme= in settings.txt, the page's file name
   (zune-now-playing.html shows zune: the files from before the looks were
   merged into one page), then defaultTheme.

   Spotify refresh tokens are single-use: every refresh returns a new one.
   The newest token (and the current access token) is kept in localStorage
   so the next refresh, the next OBS start, and other widgets in the same
   OBS all keep working from one settings.txt. Pasting a new token into
   settings.txt starts a fresh chain.

   Spotify requests are kept to a minimum. Development-mode apps have a
   request quota counted over many hours on top of the 30-second rate
   limit, and polling every two seconds all stream long uses it up. So:

     - the widget knows when the current track ends (progress + duration)
       and asks exactly then, so track changes still show within a second;
     - between those, it asks every poll_interval right after something
       happened (a skip, pause, or seek: the moment more may follow) and
       relaxes to poll_interval_max while a track plays undisturbed;
     - while nothing is playing it slows down to one request per 30 s;
     - widgets in the same OBS share one poller and its answers.

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

  /* auto-update */
  var UPDATE_URL     = 'https://masstarvt.github.io/Spotify-Widget/';   // where each release is published
  // Stamped by `git archive` when a release is built (e.g. V7). The literal
  // placeholder means a working copy: those never auto-update.
  var WIDGET_VERSION = '$Format:%(describe:tags,match=V[0-9]*)$';
  var UPDATE_CHECK_TIMEOUT_MS = 3000;   // version.json: tiny, so a slow network costs at most this
  var UPDATE_FETCH_TIMEOUT_MS = 5000;   // the widget page and script, fetched together
  var UPDATE_RECHECK_MS = 600000;       // one version check per OBS per 10 min, shared by all widgets
  var UPDATE_KEY = STORE_KEY + ':update';

  var REQUEST_TIMEOUT_MS = 10000;  // give up on a Spotify request after this long
  var SPOTIFY_RETRY_MS   = 30000;  // how long to back off after repeated failures
  var PLACEHOLDER_MS     = 3000;   // show the placeholder if nothing answers by then
  var IDLE_PAUSE_MS      = 6000;   // "nothing playing" for this long marks the shown track paused
  var MIN_ART_WIDTH      = 160;    // smallest Spotify cover that still looks sharp in a widget
  var TOKEN_MARGIN_MS    = 60000;  // refresh the access token this long before it expires

  /* polling schedule */
  var MIN_POLL_MS        = 2000;   // poll_interval floor
  var DEFAULT_MAX_POLL_MS = 8000;  // poll_interval_max default: gap while a track plays undisturbed
  var IDLE_MAX_POLL_MS   = 30000;  // gap while nothing is playing
  var RAMP_STEP_MS       = 15000;  // after a change: poll_interval for 15 s, twice that for 30 s, ...
  var END_LEAD_MS        = 800;    // ask this long after the track is due to end (Spotify lags a little)
  var MAX_END_POLLS      = 3;      // stop chasing the end if Spotify keeps reporting the track past it
  var SEEK_TOLERANCE_MS  = 3000;   // progress this far from the expected position counts as a seek
  var MIN_GAP_MS         = 500;    // never two requests closer than this

  /* rate limits and quota */
  var RATE_LIMIT_MIN_MS  = 30000;  // first wait after a 429 (Retry-After is not readable from a browser)
  var RATE_LIMIT_MAX_MS  = 600000; // longest wait between attempts while rate limited
  var QUOTA_MIN_MS       = 300000; // first wait after a 429 that says the quota is used up
  var QUOTA_MAX_MS       = 1800000; // longest wait between attempts while the quota is used up
  var RETRY_AFTER_MAX_MS = 3600000; // cap on a Retry-After header, should Spotify ever expose it
  var RATE_WINDOW_MS     = 30000;  // Spotify counts requests over a rolling 30 s window
  var MAX_REQUESTS_PER_WINDOW = 20; // hard cap per OBS per 30 s, whatever settings.txt says
  var HOUR_MS            = 3600000;
  var MAX_REQUESTS_PER_HOUR = 900; // hard cap per OBS per hour (the schedule above stays well under)

  /* shared polling between widgets in one OBS */
  var FOLLOW_DELAY_MS    = 400;    // look for the poller's answer this long after it was due
  var FOLLOW_RECHECK_MS  = 500;    // and again this often while its request is in flight
  var TAKEOVER_GRACE_MS  = 2500;   // a poller this late is presumed gone (scene closed, OBS restarted)

  var settings = {
    source: 'auto',
    theme: '',                    // which look widget-now-playing.html shows (see resolveTheme)
    spotify_client_id: '',
    spotify_refresh_token: '',
    poll_interval: MIN_POLL_MS,
    poll_interval_max: DEFAULT_MAX_POLL_MS,
    auto_update: 'on',
    update_url: UPDATE_URL,
  };
  var cssVars = [];             // [name, value, look] from --name=value lines in settings.txt ('' = every look)
  var theme = '';               // the look this page shows, once resolveTheme has run
  var knownThemes = null;       // the looks the page said it can show (null: any name goes)

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
  var authFails        = 0;      // 401s in a row: the first gets a refresh at once, more count as failures
  var spotifyDeadUntil = 0;      // retry Spotify after this (repeated failures)
  var spotifyWaitUntil = 0;      // don't poll before this (429, or shared from another widget)
  var rateLimitMs      = 0;      // current 429 wait; doubles while the limit persists
  var instanceId       = Math.random().toString(36).slice(2);   // this widget, for shared polling
  var spotifyError     = '';     // last hard failure, shown in the placeholder while nothing plays
  var spotifyTimer     = null;   // pending step of the Spotify schedule
  var appliedAt        = 0;      // answeredAt of the shared answer this widget has shown

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

  // Called by a source that is reachable but has nothing to show, with how
  // long that has been the case. If a real track is on screen it stays and
  // is marked paused after IDLE_PAUSE_MS: Spotify answers 204 once a paused
  // device goes inactive, and Snip blanks its file while paused, so
  // "Nothing playing" would be wrong there. The placeholder is only used
  // while no track has been shown yet.
  function idle(forMs) {
    if (lastTrack && !lastTrack.placeholder) {
      if (forMs >= IDLE_PAUSE_MS && lastTrack.playing) {
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
    writePlayer({ waitUntil: spotifyDeadUntil, error: reason });
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
          var key = line.slice(0, eq).trim();
          var css = /^(?:([a-z0-9-]+)\.)?(--[a-z0-9-]+)$/i.exec(key);
          if (css) {                                   // --name=value, or zune.--name=value for one look
            // no comment stripping here: colours look like "#1DB954"
            // (the look is matched in applyStyles: theme= may come later in the file)
            cssVars.push([css[2], line.slice(eq + 1).trim(), css[1] ? css[1].toLowerCase() : '']);
            return;
          }
          var val = line.slice(eq + 1).replace(/\s#.*$/, '').trim();   // " # comment" after a value
          key = key.toLowerCase();
          if (key === 'poll_interval' || key === 'poll_interval_max') {
            var n = parseInt(val, 10);
            if (n >= MIN_POLL_MS) settings[key] = n;                  // below the floor: keep the default
          } else if (key === 'source') {
            val = val.toLowerCase();
            if (val === 'auto' || val === 'spotify' || val === 'snip') settings.source = val;
          } else if (key === 'theme') {
            settings.theme = themeName(val);
          } else if (Object.prototype.hasOwnProperty.call(settings, key)) {
            settings[key] = val;
          }
        });
      }
      if (settings.poll_interval_max < settings.poll_interval) settings.poll_interval_max = settings.poll_interval;
      // https only, so a copied settings.txt cannot point the updater at an
      // unprotected address; plain http is allowed for this computer (testing).
      if (!/^https:\/\//i.test(settings.update_url) &&
          !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(settings.update_url)) settings.update_url = UPDATE_URL;
      if (settings.update_url.slice(-1) !== '/') settings.update_url += '/';
      done();
    });
  }

  /* ── this page ──────────────────────────────────────────────────────── */

  function pageName() {                    // e.g. "zune-now-playing.html"
    var p = (typeof location !== 'undefined' && location.pathname) || '';
    try { p = decodeURIComponent(p); } catch (e) { /* keep as is */ }
    return p.slice(p.lastIndexOf('/') + 1);
  }

  function widgetName() {                  // e.g. "zune"; "widget" for widget-now-playing.html
    return pageName().replace(/-now-playing\.html$/i, '').toLowerCase();
  }

  /* ── the look ───────────────────────────────────────────────────────── */

  function themeName(s) {                  // "Apple Music", "apple-music-now-playing.html" -> "apple-music"
    s = String(s || '').trim().toLowerCase().replace(/(-now-playing)?\.html$/, '').replace(/[\s_]+/g, '-');
    return /^[a-z0-9-]+$/.test(s) ? s : '';
  }

  function pageTheme() {                   // ?theme=space on the page address (one OBS source in URL mode)
    var m = /[?&]theme=([^&#]*)/i.exec((typeof location !== 'undefined' && location.search) || '');
    var v = '';
    if (m) { try { v = decodeURIComponent(m[1]); } catch (e) { v = m[1]; } }
    return themeName(v);
  }

  // Which look to show: the page address, then settings.txt, then the file
  // name (zune-now-playing.html shows zune, for the files from before the
  // looks were merged into one page), then the page's default. When the
  // page says which looks it has, only those count.
  function resolveTheme(opts) {
    knownThemes = opts.themes || null;
    function known(name) { return name && (!knownThemes || knownThemes.indexOf(name) !== -1) ? name : ''; }
    if (settings.theme && !known(settings.theme)) {
      try { console.warn('settings.txt: theme=' + settings.theme + ' is not one of ' + knownThemes.join(', ')); } catch (e) { /* no console */ }
    }
    theme = known(pageTheme()) || known(settings.theme) || known(widgetName()) || themeName(opts.defaultTheme) || widgetName();
    if (theme && typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.setAttribute('data-theme', theme);
    }
    window.NowPlayingSource.theme = theme;
  }

  // The --name=value lines from settings.txt become CSS variables on <html>,
  // above the widget's own :root block, so colours and positions live with
  // the credentials and survive updates. zune.--name=value lines count for
  // that look only.
  function applyStyles() {
    if (typeof document === 'undefined' || !document.documentElement) return;
    var root = document.documentElement;
    cssVars.forEach(function (v) {
      if (v[2] && v[2] !== theme) return;
      try { root.style.setProperty(v[0], v[1]); } catch (e) { /* not a usable value */ }
    });
    // A page from before the looks were merged that has updated itself into
    // the merged page carries its :root block along (the old script wrote
    // it, under this id). Those are one look's values: scope them to that
    // look, so they do not leak into another one chosen with theme=.
    var carried = document.getElementById('now-playing-local-root');
    var stem = widgetName();
    if (carried && stem && knownThemes && knownThemes.indexOf(stem) !== -1) {
      carried.textContent = carried.textContent.replace(/:root(\s*\{)/, '[data-theme="' + stem + '"]$1');
    }
  }

  /* ── auto-update ────────────────────────────────────────────────────── */

  function versionNumber(s) {              // "V7" or "V7-2-gabc123" -> 7; anything else -> null
    var m = /^v(\d+)/i.exec(String(s || '').trim());
    return m ? parseInt(m[1], 10) : null;
  }

  function stampOf(js) {                   // the WIDGET_VERSION inside a copy of this file
    var m = /WIDGET_VERSION\s*=\s*'([^']*)'/.exec(js || '');
    return m ? m[1] : '';
  }

  function readJSON(key) {
    try { return JSON.parse(localStorage.getItem(key)) || null; } catch (e) { return null; }
  }

  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
  }

  function fetchText(url, timeoutMs, done) {   // done(text) or done(null) on any failure
    var finished = false;
    function finish(text) { if (!finished) { finished = true; done(text); } }
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.timeout = timeoutMs;
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        finish(xhr.status === 200 && xhr.responseText ? xhr.responseText : null);
      };
      xhr.send();
    } catch (e) { finish(null); }
  }

  // What the new page must keep from this one: the :root block of the
  // widget's own stylesheet (the README's place for edits) and, in the
  // merged page, the block of the look in use; then any stylesheet added
  // after it, such as the Custom CSS OBS injects. A page from before the
  // looks were merged has no look blocks; its :root is one look's values
  // and gets the id applyStyles scopes to that look.
  function carriedStyles() {
    if (typeof document === 'undefined') return '';
    var styles = document.getElementsByTagName('style'), out = '';
    for (var i = 0; i < styles.length; i++) {
      var text = styles[i].textContent || '';
      if (text.indexOf('<\/style') !== -1 || text.indexOf('<\/script') !== -1) continue;
      if (i === 0) {
        var merged = text.indexOf('[data-theme=') !== -1;
        var t = merged && theme && new RegExp('\\[data-theme="' + theme + '"\\]\\s*\\{[^}]*\\}').exec(text);
        if (t) out += '<style id="now-playing-user-theme">\n/* the ' + theme + ' values from the local copy of this widget */\n' + t[0] + '\n</style>\n';
        var m = /:root\s*\{[^}]*\}/.exec(text);
        if (m) out += '<style id="' + (merged ? 'now-playing-user-root' : 'now-playing-local-root') + '">\n/* your values from the local copy of this widget */\n' + m[0] + '\n</style>\n';
      } else {
        out += '<style>' + text + '</style>\n';
      }
    }
    return out;
  }

  // Run the newest release from the web instead of these local files when
  // there is one. Called once, before any source starts, so nothing needs
  // stopping: the page is replaced in place with document.write and keeps
  // its address, so settings.txt, Snip files and the stored login keep
  // working. The new page carries this one's customisations (see above) and
  // gets the new script inlined, checked to be a stamped copy of this file.
  // Anything that goes wrong means the local files run, as they always did.
  // Skipped in working copies (unstamped version), with auto_update=off,
  // and in a page a previous check swapped in.
  function checkForUpdate(done) {
    var local = versionNumber(WIDGET_VERSION);
    if (window.NOW_PLAYING_UPDATED || local === null ||
        /^(off|no|false|0)$/i.test(settings.auto_update) ||
        !/-now-playing\.html$/i.test(pageName())) { done(); return; }
    var base = settings.update_url;
    // One check per OBS per UPDATE_RECHECK_MS: scene switches that reload
    // widgets, and several widgets, share one answer.
    var seen = readJSON(UPDATE_KEY);
    if (seen && seen.version && Date.now() - seen.at < UPDATE_RECHECK_MS) { decide(seen.version); return; }
    fetchText(base + 'version.json?_=' + Date.now(), UPDATE_CHECK_TIMEOUT_MS, function (text) {
      var version = null;
      try { version = String(JSON.parse(text).version || ''); } catch (e) { /* no usable answer */ }
      if (version) writeJSON(UPDATE_KEY, { at: Date.now(), version: version });
      decide(version);
    });

    function decide(version) {
      var remote = versionNumber(version);
      if (remote === null || remote <= local) { done(); return; }
      var q = '?v=' + encodeURIComponent(version), html = null, js = null, left = 2;
      fetchText(base + pageName() + q, UPDATE_FETCH_TIMEOUT_MS, function (t) { html = t; if (--left === 0) swap(); });
      fetchText(base + 'now-playing-source.js' + q, UPDATE_FETCH_TIMEOUT_MS, function (t) { js = t; if (--left === 0) swap(); });

      function swap() {
        var marker = '<script src="now-playing-source.js"><\/script>';
        // (the closing tag below is written with an escape so this file can be
        // inlined itself: an HTML parser ends an inline script at that text)
        if (!html || html.split(marker).length !== 2 ||
            !js || js.indexOf('NowPlayingSource') === -1 || js.indexOf('<\/script') !== -1 ||
            versionNumber(stampOf(js)) !== remote) { done(); return; }
        html = html.replace(marker, function () { return '<script>\n' + js + '\n<\/script>'; });
        var extra = carriedStyles(), head = html.indexOf('</head>');
        html = head === -1 ? extra + html : html.slice(0, head) + extra + html.slice(head);
        window.NOW_PLAYING_UPDATED = { version: version, from: WIDGET_VERSION };
        try {
          document.open();
          document.write(html);
          document.close();
        } catch (e) {
          window.NOW_PLAYING_UPDATED = null;
          done();
        }
      }
    }
  }

  function spotifyConfigured() {
    return !!(settings.spotify_client_id && settings.spotify_refresh_token);
  }

  function wantSpotify() {
    return spotifyConfigured() && settings.source !== 'snip';
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
      return (s && typeof s === 'object' && s.seed === settings.spotify_refresh_token) ? s : null;
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
    authFails        = 0;
    accessToken      = null;
    lastSnipRaw      = null;   // re-read Snip from scratch so the fallback shows the current track
  }

  /* ── Spotify Web API ────────────────────────────────────────────────── */

  // Pick up a token another widget refreshed, and drop ours when it is
  // about to expire, so the next poll is never wasted on a 401.
  function syncAccessToken() {
    var stored = readStore(), now = Date.now();
    if (stored && stored.access_token && stored.access_token !== staleAccessToken &&
        stored.expires_at > now + TOKEN_MARGIN_MS) {
      accessToken = stored.access_token;
    } else if (stored && stored.access_token === accessToken) {
      accessToken = null;                    // ours, and expiring
    }
    return !!accessToken;
  }

  function refreshAccessToken(done) {
    if (refreshing) return;

    // Another widget in this OBS may already have refreshed: reuse its tokens.
    if (syncAccessToken()) {
      if (done) done(true);
      return;
    }
    var stored = readStore();
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
        // (spotifyFails is only reset by a successful poll: a login that
        // works while every request after it fails must still back off)
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
          // flight; the next attempt picks up its tokens from storage.
        } else {
          // Expired (6 months), revoked, or already used from another copy
          // of settings.txt: only a new login fixes this.
          spotifyFailed('Spotify login expired: run setup-spotify again');
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

  // Rate limits are per app, so widgets in the same OBS share one poller
  // through localStorage. The record holds who polls (owner), when its
  // request started (at) and finished (doneAt), the last good answer
  // (status, text, answeredAt, state) and when the next request is due
  // (nextAt). The others show its answers and only take over when it stops.
  function playerKey() {
    return STORE_KEY + ':player:' + settings.spotify_refresh_token;
  }

  function readPlayer() {
    try {
      var p = JSON.parse(localStorage.getItem(playerKey()));
      return p && typeof p === 'object' ? p : null;
    } catch (e) { return null; }
  }

  function writePlayer(fields) {
    var p = readPlayer() || {};
    for (var k in fields) {
      if (Object.prototype.hasOwnProperty.call(fields, k)) p[k] = fields[k];
    }
    try { localStorage.setItem(playerKey(), JSON.stringify(p)); } catch (e) { /* storage unavailable */ }
  }

  // A 429 or a hard failure seen by any widget parks all of them, with the
  // same message. Returns the shared record. A wait that is already over
  // (left behind by an earlier OBS session, say) is ignored, message and
  // all: showing "retrying in 30 s" from last week would be wrong.
  function syncSharedWait() {
    var shared = readPlayer();
    if (shared && shared.waitUntil > spotifyWaitUntil && shared.waitUntil > Date.now()) {
      spotifyWaitUntil = shared.waitUntil;
      lastSnipRaw      = null;               // let Snip take over meanwhile
      if (shared.error) {
        spotifyError = shared.error;
        if ((!lastTrack || lastTrack.placeholder) && !(lastTrack && lastTrack.artist === shared.error)) {
          emitPlaceholder(shared.error);
        }
      }
    }
    return shared;
  }

  // Hard caps: never more than MAX_REQUESTS_PER_WINDOW Spotify requests per
  // rolling 30 s, or MAX_REQUESTS_PER_HOUR per hour, from this OBS, counted
  // across all widgets, whatever the settings say. Returns how long to wait,
  // and registers the request when that is 0.
  function budgetWaitMs() {
    var key = STORE_KEY + ':requests:' + settings.spotify_refresh_token;
    var now = Date.now(), stamps = [];
    try { stamps = JSON.parse(localStorage.getItem(key)) || []; } catch (e) { /* none yet */ }
    if (!Array.isArray(stamps)) stamps = [];   // a damaged record must not stop the widget
    stamps = stamps.filter(function (t) { return typeof t === 'number' && now - t < HOUR_MS; });
    var wait = 0;
    if (stamps.length >= MAX_REQUESTS_PER_HOUR) wait = stamps[stamps.length - MAX_REQUESTS_PER_HOUR] + HOUR_MS - now;
    var inWindow = stamps.filter(function (t) { return now - t < RATE_WINDOW_MS; });
    if (inWindow.length >= MAX_REQUESTS_PER_WINDOW) {
      wait = Math.max(wait, inWindow[inWindow.length - MAX_REQUESTS_PER_WINDOW] + RATE_WINDOW_MS - now);
    }
    if (wait > 0) return Math.min(Math.max(wait, MIN_GAP_MS), IDLE_MAX_POLL_MS);
    stamps.push(now);
    try { localStorage.setItem(key, JSON.stringify(stamps)); } catch (e) { /* storage unavailable */ }
    return 0;
  }

  /* ── Spotify schedule ───────────────────────────────────────────────── */

  function scheduleSpotify(at) {
    if (spotifyTimer !== null) clearTimeout(spotifyTimer);
    spotifyTimer = setTimeout(spotifyStep, Math.max(0, at - Date.now()));
  }

  // Gap between requests: poll_interval right after something changed, then
  // twice that, four times, ... up to `cap` as the situation settles.
  function rampGap(sinceChange, cap) {
    var gap = settings.poll_interval, step = RAMP_STEP_MS;
    while (sinceChange >= step && gap < cap) {
      gap  = Math.min(gap * 2, cap);
      step *= 2;
    }
    return Math.min(gap, cap);
  }

  // Compact description of an answer, compared with the previous one to see
  // whether anything happened (new track, play/pause, seek), and kept in the
  // shared record so a widget that takes over continues the same schedule.
  function nextState(status, data, prev, now) {
    var st = { kind: 'idle', id: null, playing: false, progress: 0, duration: 0,
               at: now, changedAt: now, endPolls: 0, endDue: false };
    if (status === 200 && data && data.item) {
      st.kind     = 'track';
      st.id       = data.item.id || data.item.uri || data.item.name || '?';
      st.playing  = !!data.is_playing;
      st.progress = data.progress_ms || 0;
      st.duration = data.item.duration_ms || 0;
    } else if (status === 200) {
      st.kind = 'other';                     // ad break or unknown item type
    }
    if (!prev) return st;

    var changed = prev.kind !== st.kind || prev.id !== st.id || prev.playing !== st.playing;
    if (!changed && st.kind === 'track' && st.progress !== prev.progress) {
      var expected = prev.progress + (prev.playing ? now - prev.at : 0);
      if (Math.abs(st.progress - expected) > SEEK_TOLERANCE_MS) changed = true;   // seek, or repeat-one restart
    }
    // A paused device going inactive is Spotify's doing, not the user's:
    // keep relaxing rather than polling fast again.
    if (changed && st.kind === 'idle' && prev.kind === 'track' && !prev.playing) changed = false;
    if (!changed) {
      st.changedAt = prev.changedAt;
      st.endPolls  = prev.endDue ? prev.endPolls + 1 : prev.endPolls;   // resets on the next change
    }
    return st;
  }

  // When to ask next: at the ramped gap, or exactly when the playing track
  // is due to end, whichever comes first. The gap grows to poll_interval_max
  // while a track plays, twice that while it stays paused (only a resume
  // can follow), and IDLE_MAX_POLL_MS while nothing is playing at all.
  function nextPollAt(st, now) {
    var cap = st.kind === 'idle' ? IDLE_MAX_POLL_MS
            : st.kind === 'track' && !st.playing ? Math.min(settings.poll_interval_max * 2, IDLE_MAX_POLL_MS)
            : settings.poll_interval_max;
    var gap = rampGap(now - st.changedAt, cap);
    st.endDue = false;
    if (st.kind === 'track' && st.playing && st.duration > 0 && st.endPolls < MAX_END_POLLS) {
      var endIn = st.duration - st.progress + END_LEAD_MS;
      if (endIn < gap) {
        gap = Math.max(endIn, MIN_GAP_MS);
        st.endDue = true;
      }
    }
    return now + gap;
  }

  // One step of the schedule: show what the shared poller found, wait for
  // its next answer, or poll ourselves.
  function spotifyStep() {
    spotifyTimer = null;
    if (!wantSpotify()) return;
    var shared = syncSharedWait();
    var now = Date.now();
    var waitUntil = Math.max(spotifyWaitUntil, spotifyDeadUntil);
    if (now < waitUntil) {
      scheduleSpotify(waitUntil + (shared && shared.owner && shared.owner !== instanceId ? FOLLOW_DELAY_MS : 0));
      return;
    }
    if (shared && shared.owner && shared.owner !== instanceId) {
      var inFlight = shared.at > (shared.doneAt || 0);
      var live = inFlight
        ? now - shared.at < REQUEST_TIMEOUT_MS + TAKEOVER_GRACE_MS
        : shared.nextAt > 0 && now < shared.nextAt + TAKEOVER_GRACE_MS;
      if (live) {
        if (shared.answeredAt > appliedAt && shared.state) {
          appliedAt = shared.answeredAt;
          var data = null;
          if (shared.status === 200) { try { data = JSON.parse(shared.text); } catch (e) { /* malformed */ } }
          render(shared.status, data, shared.state);
        }
        scheduleSpotify(inFlight ? now + FOLLOW_RECHECK_MS
                                 : Math.max(shared.nextAt + FOLLOW_DELAY_MS, now + FOLLOW_RECHECK_MS));
        return;
      }
      // The poller is gone (its scene was closed, or OBS restarted): take over.
    }
    pollSpotify();
  }

  function pollSpotify() {
    if (polling) return;
    var now = Date.now();
    // Claim the poll before anything else, so widgets that wake up while the
    // token refresh or the request is in flight wait for the answer instead
    // of asking Spotify too.
    writePlayer({ owner: instanceId, at: now });
    if (!syncAccessToken()) {
      refreshAccessToken(function (ok) {
        if (ok) { pollSpotify(); return; }
        var retryAt = Math.max(spotifyWaitUntil, spotifyDeadUntil, Date.now() + settings.poll_interval);
        writePlayer({ doneAt: Date.now(), nextAt: retryAt });
        scheduleSpotify(retryAt);
        if (settings.source === 'auto') pollSnip();   // fall back without waiting a tick
      });
      return;
    }
    var budgetWait = budgetWaitMs();
    if (budgetWait > 0) {
      writePlayer({ doneAt: now, nextAt: now + budgetWait });
      scheduleSpotify(now + budgetWait);
      return;
    }
    polling = true;
    writePlayer({ at: now });
    var xhr = new XMLHttpRequest();
    xhr.open('GET', PLAYER_URL, true);
    xhr.timeout = REQUEST_TIMEOUT_MS;
    xhr.setRequestHeader('Authorization', 'Bearer ' + accessToken);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      polling = false;
      var t = Date.now();
      if (xhr.status === 200 || xhr.status === 204) {
        var data = null;
        if (xhr.status === 200) { try { data = JSON.parse(xhr.responseText); } catch (e) { /* malformed */ } }
        var prev = readPlayer();
        var st = nextState(xhr.status, data, prev && prev.state, t);
        var nextAt = nextPollAt(st, t);
        writePlayer({ status: xhr.status, text: xhr.status === 200 ? xhr.responseText : '',
                      doneAt: t, answeredAt: t, nextAt: nextAt, state: st, error: '' });
        appliedAt = t;
        render(xhr.status, data, st);
        scheduleSpotify(nextAt);
        return;
      }
      handlePlayerError(xhr.status, xhr.responseText, xhr);
      // A first 401: refresh and ask again now. Anything else, including a
      // 401 on a token that was just refreshed, waits a poll_interval.
      var retryAt = Math.max(spotifyWaitUntil, spotifyDeadUntil,
                             accessToken || authFails > 1 ? t + settings.poll_interval : t);
      writePlayer({ doneAt: t, nextAt: retryAt });
      scheduleSpotify(retryAt);
    };
    try { xhr.send(); } catch (e) {
      polling = false;
      spotifyFails++;
      writePlayer({ doneAt: Date.now(), nextAt: Date.now() + settings.poll_interval });
      scheduleSpotify(Date.now() + settings.poll_interval);
    }
  }

  function render(status, data, st) {
    spotifyFails = 0;
    authFails    = 0;
    spotifyError = '';
    rateLimitMs  = 0;
    if (st.kind === 'track') {
      // (a shared answer whose text did not parse: keep what is shown)
      if (data && data.item) emit(spotifyTrack(data));
    } else {
      idle(Date.now() - st.changedAt);         // nothing playing, ad break, or unknown item type
    }
  }

  function countFailure(status) {
    spotifyFails++;
    if (spotifyFails >= 5) {
      spotifyFailed(status ? 'Spotify error (HTTP ' + status + ')' : 'Spotify unreachable');
    }
  }

  function handlePlayerError(status, text, xhr) {
    if (status === 403) {
      // A development-mode app only serves accounts the owner listed under
      // User Management in the Developer Dashboard.
      var msg = '';
      try { msg = JSON.parse(text).error.message || ''; } catch (e) { /* no body */ }
      spotifyFailed(/not registered/i.test(msg)
        ? 'Spotify: this account is not added to the app'
        : 'Spotify: ' + (msg || 'access denied'));
    } else if (status === 401) {
      // Expired: refresh right away. When the token that was just refreshed
      // is rejected as well, that is a failure like any other, so the
      // retries slow down instead of refreshing and asking in a tight loop.
      staleAccessToken = accessToken;
      accessToken = null;
      if (++authFails > 1) countFailure(status);
    } else if (status === 429) {
      rateLimited(xhr, text);
    } else {
      countFailure(status);
    }
  }

  // Spotify limits requests per app over a rolling 30 s window, and gives
  // development-mode apps a request quota on top, counted over many hours
  // ("reason": "QUOTA_EXCEEDED" in the 429 body). Browsers cannot read its
  // Retry-After header (Spotify does not expose it to scripts), so wait in
  // growing steps instead, and make every widget in this OBS wait too.
  function rateLimited(xhr, text) {
    var reason = '';
    try { reason = JSON.parse(text).error.reason || ''; } catch (e) { /* no body */ }
    var quota = /quota/i.test(reason);
    var minMs = quota ? QUOTA_MIN_MS : RATE_LIMIT_MIN_MS;
    var maxMs = quota ? QUOTA_MAX_MS : RATE_LIMIT_MAX_MS;
    var header = 0;
    try { header = parseInt(xhr.getResponseHeader('Retry-After'), 10); } catch (e) { /* not exposed */ }
    var waitMs = header > 0 ? Math.min(header * 1000, RETRY_AFTER_MAX_MS)
               : rateLimitMs ? Math.min(rateLimitMs * 2, maxMs) : minMs;
    rateLimitMs      = waitMs;
    spotifyWaitUntil = Date.now() + waitMs;
    lastSnipRaw      = null;                 // let Snip take over meanwhile
    var msg = (quota ? 'Spotify request quota used up, retrying in ' : 'Spotify rate limited, retrying in ') +
      (waitMs < 60000 ? Math.round(waitMs / 1000) + ' s' : Math.round(waitMs / 60000) + ' min');
    spotifyError = msg;
    writePlayer({ waitUntil: spotifyWaitUntil, error: msg });
    if (!lastTrack || lastTrack.placeholder) emitPlaceholder(msg);
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
        if (ok) idle(++snipIdleTicks * settings.poll_interval);
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

  // Snip is read on a fixed interval (local files, no limits). Spotify runs
  // on its own schedule (see above); this tick only restarts that schedule
  // if it ever stalls, and reads Snip while Spotify is down or rate limited.
  function tick() {
    var spotify = wantSpotify();
    if (spotify) syncSharedWait();
    var now = Date.now();
    if (spotify && now >= spotifyDeadUntil && now >= spotifyWaitUntil) {
      if (spotifyTimer === null && !polling && !refreshing) scheduleSpotify(now);
    } else if (settings.source !== 'spotify') {
      pollSnip();
    }
  }

  // Another widget's answer landed (or it claimed the poll): react now
  // rather than at the next check. Only browsers that share storage between
  // pages deliver this; the timed checks cover the rest.
  function onStorage(e) {
    if (!e || e.key !== playerKey() || !wantSpotify()) return;
    var shared = readPlayer();
    if (shared && shared.owner === instanceId) return;
    scheduleSpotify(Date.now());
  }

  function begin() {
    // If no source produces data shortly after startup, show a
    // "not running" placeholder instead of staying invisible.
    setTimeout(function () {
      if (!lastTrack) emitPlaceholder(placeholderReason());
    }, PLACEHOLDER_MS);
    refreshToken = settings.spotify_refresh_token;
    if (wantSpotify()) {
      try { window.addEventListener('storage', onStorage); } catch (e) { /* no storage events */ }
      spotifyStep();                         // shows a shared answer at once, or polls
    } else {
      tick();
    }
    setInterval(tick, settings.poll_interval);
  }

  window.NowPlayingSource = {
    version: WIDGET_VERSION,
    theme: '',                             // the look in use, set by start()
    start: function (cb, opts) {
      callback = cb;
      opts = opts || {};
      loadSettings(function () {
        resolveTheme(opts);                  // before the update check: a new page keeps this look's values
        checkForUpdate(function () {         // returns at once unless a newer release replaces this page
          if (opts.onTheme) opts.onTheme(theme);
          applyStyles();
          begin();
        });
      });
    },
    getLastTrack: function () { return lastTrack; },
  };
}());
