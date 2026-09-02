/* ────────────────────────────────────────────────────────────────────────
   now-playing-source.js — shared data source for the now-playing widgets.

   Reads settings.txt (next to the HTML file) to decide where track info
   comes from:

     source=auto     use Spotify Web API if credentials work, else Snip files
     source=spotify  Spotify Web API only
     source=snip     Snip files only (same as no settings.txt at all)

   Widgets call:

     NowPlayingSource.start(function (track) {
       // track = { title, artist, album, artSrc, playing }
       // artSrc is a URL usable as img.src (https URL for Spotify,
       // blob object URL for Snip artwork), or null if not yet known.
     });

   Works on file:// inside OBS's browser source (XHR with status 0).
   ──────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var SETTINGS_FILE = 'settings.txt';
  var SNIP_TXT      = 'Snip/Snip.txt';
  var SNIP_ART      = 'Snip/Snip_artwork.jpg';
  var TOKEN_URL     = 'https://accounts.spotify.com/api/token';
  var PLAYER_URL    = 'https://api.spotify.com/v1/me/player/currently-playing';

  var settings = {
    source: 'auto',
    spotify_client_id: '',
    spotify_refresh_token: '',
    poll_interval: 2000,
  };

  var callback     = null;
  var accessToken  = null;
  var spotifyDead  = false;   // true after repeated Spotify failures → fall back to Snip
  var spotifyFails = 0;
  var refreshing   = false;

  var lastSnipRaw    = null;
  var snipBlobUrl    = null;
  var lastTrack      = null;

  /* ── small helpers ──────────────────────────────────────────────────── */

  function xhrGet(url, opts, done) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    if (opts.mime) xhr.overrideMimeType(opts.mime);
    if (opts.blob) xhr.responseType = 'blob';
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      done(xhr);
    };
    try { xhr.send(); } catch (e) { done({ status: -1 }); }
  }

  function emit(track) {
    lastTrack = track;
    if (callback) callback(track);
  }

  /* ── settings.txt ───────────────────────────────────────────────────── */

  function loadSettings(done) {
    xhrGet(SETTINGS_FILE, { mime: 'text/plain; charset=utf-8' }, function (xhr) {
      if ((xhr.status === 200 || xhr.status === 0) && xhr.responseText) {
        xhr.responseText.split('\n').forEach(function (line) {
          line = line.trim();
          if (!line || line.charAt(0) === '#') return;
          var eq = line.indexOf('=');
          if (eq === -1) return;
          var key = line.slice(0, eq).trim();
          var val = line.slice(eq + 1).trim();
          // strip trailing inline comment
          var hash = val.indexOf('#');
          if (hash !== -1) val = val.slice(0, hash).trim();
          if (key === 'poll_interval') {
            var n = parseInt(val, 10);
            if (n >= 500) settings.poll_interval = n;
          } else if (key in settings) {
            settings[key] = val;
          }
        });
      }
      done();
    });
  }

  function spotifyConfigured() {
    return settings.spotify_client_id && settings.spotify_refresh_token;
  }

  /* ── Spotify Web API ────────────────────────────────────────────────── */

  function refreshAccessToken(done) {
    if (refreshing) return;
    refreshing = true;
    var xhr = new XMLHttpRequest();
    xhr.open('POST', TOKEN_URL, true);
    xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      refreshing = false;
      if (xhr.status === 200) {
        try {
          var data = JSON.parse(xhr.responseText);
          accessToken = data.access_token;
          // Spotify may rotate the refresh token; we can't persist it from
          // file://, but the old one keeps working within the session.
          spotifyFails = 0;
          if (done) done(true);
          return;
        } catch (e) { /* fall through */ }
      }
      accessToken = null;
      spotifyFails++;
      if (spotifyFails >= 3) spotifyDead = true;
      if (done) done(false);
    };
    xhr.send(
      'grant_type=refresh_token' +
      '&refresh_token=' + encodeURIComponent(settings.spotify_refresh_token) +
      '&client_id=' + encodeURIComponent(settings.spotify_client_id)
    );
  }

  function pollSpotify() {
    if (!accessToken) { refreshAccessToken(); return; }
    var xhr = new XMLHttpRequest();
    xhr.open('GET', PLAYER_URL, true);
    xhr.setRequestHeader('Authorization', 'Bearer ' + accessToken);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if (xhr.status === 200 && xhr.responseText) {
        spotifyFails = 0;
        try {
          var data = JSON.parse(xhr.responseText);
          if (data && data.item) {
            var images = (data.item.album && data.item.album.images) || [];
            emit({
              title:   data.item.name,
              artist:  (data.item.artists || []).map(function (a) { return a.name; }).join(', '),
              album:   data.item.album ? data.item.album.name : '',
              artSrc:  images.length ? images[0].url : null,
              playing: !!data.is_playing,
            });
          }
        } catch (e) { /* ignore malformed response */ }
      } else if (xhr.status === 204) {
        // nothing playing — keep showing the last track, just not an error
        spotifyFails = 0;
      } else if (xhr.status === 401) {
        accessToken = null;   // expired → refresh on next tick
      } else if (xhr.status === 429) {
        // rate limited — do nothing this tick
      } else {
        spotifyFails++;
        if (spotifyFails >= 5) spotifyDead = true;
      }
    };
    xhr.send();
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

  function fetchSnipArtwork(track) {
    xhrGet(SNIP_ART, { blob: true }, function (xhr) {
      if ((xhr.status === 200 || xhr.status === 0) && xhr.response && xhr.response.size > 0) {
        var newUrl = URL.createObjectURL(xhr.response);
        if (snipBlobUrl) URL.revokeObjectURL(snipBlobUrl);
        snipBlobUrl = newUrl;
        track.artSrc = newUrl;
        emit(track);
      }
    });
  }

  function pollSnip() {
    xhrGet(SNIP_TXT, { mime: 'text/plain; charset=utf-8' }, function (xhr) {
      if ((xhr.status === 200 || xhr.status === 0) && xhr.responseText && xhr.responseText.trim()) {
        var raw = xhr.responseText;
        if (raw === lastSnipRaw) return;
        lastSnipRaw = raw;
        var t = parseSnip(raw);
        if (t) {
          var track = { title: t.title, artist: t.artist, album: '', artSrc: null, playing: true };
          emit(track);                // text right away…
          fetchSnipArtwork(track);    // …artwork when it loads
        }
      }
    });
  }

  /* ── main loop ──────────────────────────────────────────────────────── */

  function tick() {
    var useSpotify =
      settings.source === 'spotify' ||
      (settings.source === 'auto' && spotifyConfigured() && !spotifyDead);
    if (useSpotify) pollSpotify();
    else pollSnip();
  }

  window.NowPlayingSource = {
    start: function (cb) {
      callback = cb;
      // If no source produces data shortly after startup, show a
      // "not running" placeholder instead of staying invisible.
      setTimeout(function () {
        if (!lastTrack) {
          if (callback) callback({
            title: 'Nothing playing',
            artist: 'Spotify not detected',
            album: '', artSrc: null, playing: false, placeholder: true,
          });
        }
      }, 3000);
      loadSettings(function () {
        if (settings.source !== 'snip' && spotifyConfigured()) {
          refreshAccessToken(function () { tick(); });
        } else {
          tick();
        }
        setInterval(tick, settings.poll_interval);
      });
    },
    getLastTrack: function () { return lastTrack; },
  };
}());
