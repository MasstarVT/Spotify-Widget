# Now Playing — OBS Widgets

"Now Playing" overlays for OBS Studio in several styles. Each widget displays the current song title, artist, and album artwork from **either**:

- **The Spotify Web API** (no extra software — see [Spotify API Setup](#spotify-api-setup)), or
- **[Snip](https://github.com/dlrudie/Snip/releases)** output files (the original method, still fully supported)

All widgets share `now-playing-source.js`, which picks the source based on `settings.txt`. With no `settings.txt` at all, the widgets read Snip files exactly as before.

> **Important:** the widget HTML files must stay in the same folder as `now-playing-source.js` (and `settings.txt`, if you use it).

## Widgets

| File | Style |
|---|---|
| `zune-now-playing.html` | Zune: accent bar, large title, dark panel |
| `spotify-now-playing.html` | Spotify-style card with equalizer bars |
| `apple-music-now-playing.html` | Apple Music card, tinted from the album art |
| `ipod-now-playing.html` | Classic iPod screen |
| `xbox-now-playing.html` | Green glow, typewriter label, drifting mist |
| `basic-now-playing.html` | Plain dark card |
| `minimal-rect-now-playing.html` | Art and text, no background |
| `minimal-square-now-playing.html` | Large square art with centered text |
| `candy-now-playing.html` | Cycling rainbow border and bubbly fonts |
| `pixel-now-playing.html` | 8-bit look with scanlines |
| `space-now-playing.html` | Starfield, orbit ring, and scanner line |

Widgets other than Zune, Spotify, Apple Music, iPod, and Basic load their fonts from Google Fonts, so they need internet access when OBS starts; offline they fall back to a system font.

---

## Requirements

- [OBS Studio](https://obsproject.com/)
- One of:
  - A Spotify Developer app (for the Spotify API source). Since February 2026 Spotify requires the app owner to have **Spotify Premium**, and a development-mode app is limited to one client ID and five users, which is plenty for your own overlay. **or**
  - [Snip](https://github.com/dlrudie/Snip/releases) — writes the current track info and artwork to disk

---

## Spotify API Setup

One-time setup, done in your normal browser (not OBS):

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), log in, and click **Create app**. Name it anything, add the Redirect URI `http://127.0.0.1:8888/callback`, check **Web API**, and save.
2. Open `spotify-setup.html` (double-click it) and follow the steps on the page: paste your app's **Client ID**, authorize, and paste back the URL Spotify redirects you to. The page gives you the finished `settings.txt` contents and a **Download settings.txt** button.
3. Put `settings.txt` next to the widget HTML files (or copy `settings.example.txt` and paste the generated lines in):

   ```
   source=auto
   spotify_client_id=YOUR_CLIENT_ID
   spotify_refresh_token=YOUR_REFRESH_TOKEN
   poll_interval=2000
   ```

4. Add the widget to OBS as a browser source (see below). Play a song on Spotify — on any device — and it appears in the widget.

### How the login stays alive

Spotify refresh tokens are single-use: every refresh hands back a new one. The widget stores the newest token (and the current access token) in OBS's browser storage, so it keeps working across OBS restarts, and every widget in the same OBS shares one login. `settings.txt` is only read as the starting point.

Refresh tokens also expire after **6 months**. If the widget stops showing Spotify (it falls back to Snip, or shows "Nothing playing" while music is playing), run `spotify-setup.html` again and paste the new token into `settings.txt`. The widget notices the changed token and starts fresh.

### Rate limits

Spotify counts every request your app makes in a rolling 30-second window, per app rather than per widget, and development-mode apps get a small allowance that Spotify does not publish. When it is exceeded Spotify answers 429 for a while, and that block can last from minutes to hours.

The widget is built so one OBS cannot reach that limit:

- **Poll interval floor.** `poll_interval` is never lower than `2000` ms (lower values are ignored). One poll is one request, so that is at most 15 requests per 30-second window, and a track change still shows within about two seconds.
- **One poller per OBS.** Widgets in the same OBS share their polling: one asks Spotify and the others reuse its answer, so extra scenes or widget styles do not multiply the request rate.
- **Hard cap.** Whatever else happens, the widgets in one OBS never send more than 20 Spotify requests in any 30-second window. If the cap is reached, polls are skipped until the window frees up.
- **Slower when idle.** Once "Nothing playing" has been showing for a bit, the widget polls every third tick (every 6 seconds by default), so an OBS left open all day costs a third as much. A resume still shows within a few seconds.
- **Backing off on 429.** Browsers are not allowed to read Spotify's `Retry-After` header, so after a 429 the widget waits 30 seconds, then 1, 2, 4, 8 and at most 10 minutes between attempts until Spotify answers normally again. Every widget in that OBS waits together, with `source=auto` Snip is used meanwhile, and if nothing is on screen the widget shows "Spotify rate limited, retrying in …".

The one thing the widget cannot see is other people. The limit is per app, so if several streamers share one Client ID their requests add up: five people at the default interval are 75 requests per window, which is close to the measured ceiling. For a shared app, set `poll_interval=4000` or higher for everyone, or give each person their own app. The Troubleshooting test on `spotify-setup.html` uses three requests.

### Using it on a friend's stream (another Spotify account)

Each streamer needs their **own** `settings.txt`, made by logging in with their own Spotify account on their own machine. A `settings.txt` cannot be shared: the token inside is used up the first time a widget refreshes it, and it shows what *that account* is playing, not what the machine is playing.

There are two ways to set a friend up:

**They create their own Spotify app** (their own Client ID). Since February 2026 this requires **their own Spotify Premium**; without it the app does not work even though the setup page hands out a token. In the app's settings they need the Redirect URI `http://127.0.0.1:8888/callback` and **Web API** ticked. Then they run `spotify-setup.html` with their Client ID exactly as in the steps above.

**They use your app** (your Client ID). A development-mode app only serves the owner and the accounts the owner has listed: open [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), open the app, go to **Settings → User Management**, and add their name and the email of their Spotify account (up to five users on new apps; your Premium has to stay active). Then they run `spotify-setup.html` with **your** Client ID while logged in to **their** Spotify account.

Either way, the setup page checks the account at the end of Step 3 and shows what Spotify answered, including what is currently playing. If a widget still shows "Nothing playing" with a reason underneath, paste that `settings.txt` into the **Troubleshooting** box on `spotify-setup.html` on any computer: it does exactly what the widget does and prints Spotify's answers. Testing uses the token up, so save the updated file the test hands back.

If you tried someone else's `settings.txt` on your own machine, just put your own file back. The widget keeps a separate saved login for each `settings.txt` token, so yours resumes where it left off.

If an account is not on the list, Spotify answers every request with "User not registered in the Developer Dashboard", and the widget shows "Nothing playing / Spotify: this account is not added to the app". Once the account is added the widget starts working on its next retry; no need to redo the setup.

### settings.txt options

| Key | Meaning |
|---|---|
| `source` | `auto` (Spotify API if credentials work, else Snip files), `spotify` (API only), or `snip` (Snip files only). Not case-sensitive; anything else means `auto`. |
| `spotify_client_id` | From your Spotify Developer app |
| `spotify_refresh_token` | Generated by `spotify-setup.html` |
| `poll_interval` | How often to check for track changes, in ms (default and minimum `2000`; lower values are ignored). See [Rate limits](#rate-limits) |

Lines starting with `#` are comments, and so is ` # ...` after a value.

Fallback order with `source=auto`: **Spotify API → Snip files**. After repeated Spotify failures the widget reads Snip files for 30 seconds, then tries Spotify again.

### What the widget shows when nothing is playing

| Shown | Meaning |
|---|---|
| Last track, grayed out with the equalizer frozen | Playback is paused. This also covers Spotify dropping a long-paused device from its API and Snip blanking its file while paused, so the track stays up until something else plays |
| "Nothing playing" | The source answered but no track has been seen since the widget loaded (Spotify closed, or Snip's file empty, when OBS started) |
| "Nothing playing / No source detected" | Neither Spotify nor Snip answered within 3 seconds of loading |
| "Nothing playing / Spotify not detected" | `source=spotify` and Spotify did not answer within 3 seconds |
| "Nothing playing / Spotify not configured" | `source=spotify` but `settings.txt` has no client ID or refresh token |
| "Nothing playing / Spotify: this account is not added to the app" | The Spotify account is not listed under the app's User Management. See [Using it on a friend's stream](#using-it-on-a-friends-stream-another-spotify-account) |
| "Nothing playing / Spotify rate limited, retrying in …" | Spotify's per-app request limit was exceeded. See [Rate limits](#rate-limits) |
| "Nothing playing / Spotify login expired: re-run spotify-setup.html" | Spotify rejected the refresh token: expired after 6 months, revoked, or copied from someone else's settings.txt |
| "Nothing playing / Snip not detected" | `settings.txt` has no Spotify credentials (or says `source=snip`) and `Snip\Snip.txt` was not found next to the widget |
| "Nothing playing / No settings.txt and no Snip files" | Neither file was found next to the widget. Check the file is really named `settings.txt` (Windows may have hidden a second `.txt`) and sits in the same folder as the HTML files |
| "Nothing playing / settings.txt must be saved as UTF-8" | The file was saved with another encoding (Notepad's "Unicode"). Save it again as UTF-8 |
| "Nothing playing / Spotify unreachable", "Spotify login failed (HTTP …)" or "Spotify error (HTTP …)" | Spotify could not be reached or gave an unexpected answer. The widget retries every 30 seconds; the Troubleshooting box on `spotify-setup.html` shows the exact response |

---

## Snip Setup (alternative to the Spotify API)

If you'd rather not use the Spotify API (or want a fallback when offline), the widgets still read Snip's output files. This is used automatically when `settings.txt` is missing, `source=snip`, or the Spotify credentials stop working in `auto` mode.

### File Structure

The widget reads files from a `Snip` folder **next to the HTML file**. The simplest setup is to place the widget files directly in your user home folder (`C:\Users\YourName\`), since that is where Snip outputs by default:

```
C:\Users\YourName\
├── zune-now-playing.html
├── now-playing-source.js
└── Snip\
    ├── Snip.txt
    └── Snip_artwork.jpg
```

If you place the HTML file somewhere else, you must point Snip's output directory to a `Snip` subfolder in the same location as the HTML file.

---

## Step 1 — Install and Configure Snip

1. Download and run [Snip](https://github.com/dlrudie/Snip/releases).
2. Open Snip and go to **File → Settings**.
3. Under the **Output** tab, make sure **Save to file** is checked.
4. Set the **Output directory** to the folder that contains the widget HTML file.
   *(Snip will create a `Snip` subfolder here automatically.)*
5. Under **Track format**, set the format to:

   ```
   %title%$$n%artist%
   ```

   The `$$n` is a **newline separator** — it puts the song title on the first line and the artist on the second line, which is how the widget reads them.

6. Make sure **Save album artwork** is enabled so `Snip_artwork.jpg` is written alongside the text file.
7. Click **Save**.

> **Why `$$n`?** Without it, Snip writes everything on one line (e.g. `Song Title - Artist`). The `$$n` separator tells Snip to put the title and artist on separate lines, which the widget reads as two distinct fields.

---

## Step 2 — OBS Browser Source Setup

1. Open OBS and add a new **Browser Source** to your scene.
2. Check the **Local file** checkbox.
3. Click **Browse** and select the widget HTML file (for example `zune-now-playing.html`).
4. Set the resolution to match your canvas:
   - **Width:** `1920`
   - **Height:** `1080`
5. Leave the **Custom CSS** field blank (delete any default CSS OBS puts there).
6. **Uncheck** "Shutdown source when not visible" — keeping it active ensures the widget keeps polling for track changes even when the scene is not displayed.
7. **Check** "Refresh browser when scene becomes active" — this forces a reload when you switch to the scene.
8. Click **OK**.

The widget appears in the **bottom-left corner** of the scene. Reposition or scale it in OBS as needed.

> Opening a widget by double-clicking it only shows the placeholder: normal browsers block file reads from a `file://` page, so `settings.txt` and the Snip files cannot be loaded there. Test inside OBS.

---

## Step 3 — Verify It's Working

1. Play a song in Spotify (or whichever player Snip supports).
2. If using Snip, confirm that `Snip\Snip.txt` and `Snip\Snip_artwork.jpg` appear in the correct folder.
3. The widget should display the song title, artist, and album art within a couple of seconds.
4. If the widget shows "Nothing playing" with a reason underneath after a few seconds, no source is providing track data. See the table above and Troubleshooting below.

---

## Customization

### Colors and sizes

Every widget starts with a `:root` block at the very top of its `<style>` that holds its colors and font sizes — change those values and everything that depends on them updates. The Zune widget, for example:

```css
:root {
  --accent-rgb:   255, 69, 0;                /* main accent (bar, glow, rule) as R, G, B */
  --accent-2:     #E60073;                   /* gradient end / art fill tone   */
  --label-rgb:    255, 106, 51;              /* "now playing" label text as R, G, B */
  --title-rgb:    255, 255, 255;             /* track title text as R, G, B    */
  --artist-color: rgba(255, 255, 255, 0.85); /* artist name text               */
  --title-size:   38px;                      /* track title font size          */
  --artist-size:  15px;                      /* artist name font size          */
}
```

The `-rgb` values are plain red, green, blue numbers (0–255) rather than hex so the glows and shadows can be derived from them in every OBS version.

| Variable | Controls |
|---|---|
| `--accent-rgb` | Left accent bar, its glow, the divider rule, and the title glow |
| `--accent-2` | Bottom of the accent bar gradient and the album art background |
| `--label-rgb` | "now playing" label (glow updates automatically) |
| `--title-rgb` | Large track title text and its glow |
| `--artist-color` | Artist name below the title |
| `--title-size` / `--artist-size` | Font sizes |

### Other settings

| What to change | What to edit |
|---|---|
| Widget position | `bottom` and `left` values on the widget's outer rule (`.zune-widget`, `.sp-widget`, `.widget`, …) |
| Scroll area width (Zune) | `width` on `.zune-title-wrap` (default `420px`); other widgets scroll within their card width |
| Poll interval | `poll_interval` in `settings.txt` (default `2000` ms) |

### Paused and idle looks

The script adds the class `is-paused` to the widget while playback is paused (and while it shows "Nothing playing"), and `is-idle` for the "Nothing playing" state only. While paused the whole widget is grayed out and faded, and widgets with equalizer bars freeze them; while idle the bars are hidden. Each widget has a short "Paused / idle" section at the end of its CSS where you can change that: the `filter: grayscale(1) opacity(0.55)` line controls how gray and how faded the paused look is, and you could hide the whole widget while idle instead.

---

## Troubleshooting

**Widget shows "Nothing playing" with a reason underneath**
- See the table in [What the widget shows when nothing is playing](#what-the-widget-shows-when-nothing-is-playing).
- If using the Spotify API, check `settings.txt` exists next to the HTML file with a valid `spotify_client_id` and `spotify_refresh_token`, and that a song is actually playing.
- If using Snip, open File Explorer and check that `Snip\Snip.txt` exists next to the HTML file and contains text.
- In OBS, right-click the browser source → **Refresh** to force a reload.

**Spotify worked before but the widget now only shows Snip data, or "Nothing playing" while music plays**
- The refresh token has expired (Spotify expires them after 6 months) or the stored login was lost. Run `spotify-setup.html` again and paste the new token into `settings.txt`.
- If the app owner's Spotify Premium lapsed, the app stops working until it is renewed.

**A friend's copy shows "Nothing playing" although the setup page said Success**
- Open `spotify-setup.html`, paste their `settings.txt` into the Troubleshooting box, and read Spotify's answer. The usual causes: the app owner has no Spotify Premium (required since February 2026), the account is not listed under the app's User Management, or the `settings.txt` was copied from someone else and its token is already used up. See [Using it on a friend's stream](#using-it-on-a-friends-stream-another-spotify-account).

**Widget shows "Spotify: this account is not added to the app"**
- The Spotify account that authorized is not listed under the app's **User Management** in the Developer Dashboard. The app owner adds that account's email there; the widget starts working on its next retry without redoing the setup.
- This is also what happens when someone uses a `settings.txt` made from a different Spotify account than the app owner added.

**Artist or title is blank**
- Make sure your Snip track format is set to `%title%$$n%artist%` (with `$$n` as the separator). Without the newline separator the widget may not split the fields correctly.

**Artwork is not showing**
- Confirm **Save album artwork** is enabled in Snip's settings.
- Check that `Snip\Snip_artwork.jpg` exists in the same folder as `Snip.txt`.
- Some tracks (local files, some podcasts) have no artwork; the widget shows its placeholder art for those.

**Song info is not updating when the track changes**
- Make sure Snip is actively running and set to the correct player (Spotify, foobar2000, etc.).
- Right-click the browser source in OBS → **Refresh**.

**Widget is not visible in OBS**
- Confirm the browser source resolution matches your OBS canvas (1920×1080 by default).
- Make sure the browser source is not hidden or behind another source in the scene.

**Text appears cut off**
- Long titles scroll automatically. For the Zune widget, increase the `width` on `.zune-title-wrap` if the title area is too narrow; for card-style widgets, increase the card `width`.
