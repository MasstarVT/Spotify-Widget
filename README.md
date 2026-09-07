# Now Playing — OBS Widget

A "Now Playing" overlay for OBS Studio with eleven looks to choose from. It displays the current song title, artist, and album artwork from **either**:

- **The Spotify Web API** (no extra software — see [Spotify API Setup](#spotify-api-setup)), or
- **[Snip](https://github.com/dlrudie/Snip/releases)** output files (the original method, still fully supported)

The widget is one page, `widget-now-playing.html`. `theme=` in `settings.txt` picks the look and `now-playing-source.js` picks the source. With no `settings.txt` at all, the widget shows the Zune look and reads Snip files exactly as before.

> **Important:** keep the unzipped folder as it is: `widget-now-playing.html` next to `now-playing-source.js` and `settings.txt`, with the `tools` folder beside them. OBS browser sources point at the widget file, and it stays where it is across updates.

## Files and looks

| File | What it is |
|---|---|
| `widget-now-playing.html` | The widget. Add it to OBS as a browser source; `theme=` in `settings.txt` chooses the look |
| `now-playing-source.js` | The shared script: settings, Spotify or Snip, updates |
| `setup-spotify.bat`, `setup-spotify.sh` | One-click Spotify setup for Windows and Linux/macOS (run the helper, then the setup page does the rest) |
| `tools/` | The setup page (`spotify-setup.html`, which also works on its own, opened directly in a browser) and the helper scripts the launchers run |
| `update-widget.bat`, `update-widget.sh` | One click to bring the files in the folder up to the latest release (see [Updating](#updating)) |

| `theme=` | Look | Fonts |
|---|---|---|
| `zune` | Accent bar, large title, dark panel (the default) | system |
| `spotify` | Spotify-style card with equalizer bars | system |
| `apple-music` | Apple Music card, tinted from the album art | system |
| `ipod` | Classic iPod screen | system |
| `xbox` | Green glow, typewriter label, drifting mist | Google Fonts |
| `basic` | Plain dark card | system |
| `minimal-rect` | Art and text, no background | Google Fonts |
| `minimal-square` | Large square art with centered text | Google Fonts |
| `candy` | Cycling rainbow border and bubbly fonts | Google Fonts |
| `pixel` | 8-bit look with scanlines | Google Fonts |
| `space` | Starfield, orbit ring, and scanner line | Google Fonts |

Only the look in use is loaded, so the others cost OBS nothing. Looks marked Google Fonts fetch their fonts when OBS starts and need internet access then; offline they fall back to a system font.

To change the look, edit `theme=` in `settings.txt` and refresh the browser source (right-click it → **Refresh**). For one scene with a different look, add a browser source in URL mode (not "Local file") with an address like `file:///C:/Users/You/Widget/widget-now-playing.html?theme=candy`; the address wins over `settings.txt`.

---

## Download

Get **Widget.zip** from the [latest release](https://github.com/MasstarVT/Spotify-Widget/releases/latest) and unzip it into a folder of its own. Everything below happens in that folder, and the widgets keep themselves up to date from there (see [Updating](#updating)). The folder holds `widget-now-playing.html`, `now-playing-source.js`, `settings.txt` once set up, the four launchers, and a `tools` folder with the setup page and helper scripts.

---

## Requirements

- [OBS Studio](https://obsproject.com/)
- One of:
  - A Spotify Developer app (for the Spotify API source). Since February 2026 Spotify requires the app owner to have **Spotify Premium**, and a development-mode app is limited to one client ID and five users, which is plenty for your own overlay. **or**
  - [Snip](https://github.com/dlrudie/Snip/releases) — writes the current track info and artwork to disk

---

## Spotify API Setup

One-time setup, done on your normal desktop (not in OBS):

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), log in, and click **Create app**. Name it anything, add the Redirect URI `http://127.0.0.1:8888/callback`, check **Web API**, and save.
2. **Windows:** double-click `setup-spotify.bat`. **Linux / macOS:** run `./setup-spotify.sh` (needs Python 3, which every desktop distro and macOS ships). A small window opens and your browser shows the setup page. Paste your app's **Client ID**, click **Authorize**, approve in Spotify, and you are brought straight back: the page checks that the account can use the app and writes `settings.txt` into the widget folder by itself. Close the small window when it says done.

   The helper is a tiny local web server that listens only on your own computer (127.0.0.1, the address Spotify redirects to), serves only the setup page, and writes only `settings.txt`. Windows may show "Windows protected your PC" for a downloaded `.bat`: choose **More info → Run anyway**. Nothing is installed.

   **Without the helper:** open `tools/spotify-setup.html` directly (double-click it; Chrome or Edge gives the smoothest path). You then paste back the URL Spotify redirects you to, and in Step 4 click **Save into the widget folder** and pick the folder once; the page checks it is the right folder, writes `settings.txt` there (keeping any settings you already had), and remembers the folder. In browsers that cannot write files (Firefox, Safari) use **Download** and move the file into the folder yourself.
3. Either way you end up with a `settings.txt` next to `widget-now-playing.html` that looks like this:

   ```
   source=auto
   spotify_client_id=YOUR_CLIENT_ID
   spotify_refresh_token=YOUR_REFRESH_TOKEN
   poll_interval=2000
   ```

   Add a line such as `theme=space` to pick a look other than Zune (see [Files and looks](#files-and-looks)).

4. Add the widget to OBS as a browser source (see below). Play a song on Spotify — on any device — and it appears in the widget.

### How the login stays alive

Spotify refresh tokens are single-use: every refresh hands back a new one. The widget stores the newest token (and the current access token) in OBS's browser storage, so it keeps working across OBS restarts, and every widget in the same OBS shares one login. `settings.txt` is only read as the starting point.

Refresh tokens also expire after **6 months**. If the widget stops showing Spotify (it falls back to Snip, or shows "Nothing playing" while music is playing), run `setup-spotify.bat` / `.sh` again; it writes the new token into `settings.txt`. The widget notices the changed token and starts fresh.

### Rate limits and the request quota

Spotify puts two limits on a development-mode app. The first is a rate limit: every request counts in a rolling 30-second window, and a burst over the (unpublished) allowance gets 429 answers for minutes. The second is a request **quota**, counted per developer account over many hours: a widget that polled every two seconds all stream long used it up after several hours, and the 429 that follows (`"reason": "QUOTA_EXCEEDED"` in the body) can last most of a day. The quota is what bites on long streams, so the widget asks Spotify as rarely as it can without showing changes late:

- **Track ends are predicted.** Every answer says how far into the track Spotify is and how long the track is, so the widget asks again exactly when the track is due to end. A track that plays out shows its successor within about a second, with no polling in between.
- **Fast after something happens, relaxed when nothing does.** Right after a change the widget asks every `poll_interval` (2 s by default) for 15 seconds, since a skip or pause is often followed by another, then every 4 s, and settles at `poll_interval_max` (8 s by default) while a track plays undisturbed. A mid-track skip or pause shows within that gap. While paused it relaxes to twice `poll_interval_max`, and while nothing is playing at all to 30 seconds, so an OBS left open overnight costs about 130 requests an hour.
- **One poller per OBS.** Widgets in the same OBS share the answers: one asks Spotify, the others show what it got the moment it lands, and take over only if it stops (its scene was closed, say). Extra scenes or widget styles add no requests, and a widget that starts later shows the current track without asking at all.
- **No wasted requests.** The access token is refreshed a minute before it expires rather than after a rejected request, and a `poll_interval` under `2000` is ignored.
- **Hard caps.** Whatever else happens, the widgets in one OBS never send more than 20 Spotify requests in any 30 seconds or 900 in any hour. A poll that would exceed that is delayed.
- **Backing off on 429.** Browsers cannot read Spotify's `Retry-After` header, so after a rate-limit 429 the widget waits 30 seconds, then 1, 2, 4, 8 and at most 10 minutes between attempts. After a quota 429 it waits 5, 10, 20 and then 30 minutes between attempts, since the quota takes hours to come back. Every widget in that OBS waits together, with `source=auto` Snip is used meanwhile, and if nothing is on screen the widget shows "Spotify rate limited, retrying in …" or "Spotify request quota used up, retrying in …".

In numbers, measured in a simulation of the widget against a scripted Spotify: a track playing undisturbed costs about 570 requests an hour, an hour of constant skipping and pausing about 720, and an idle hour about 130. Polling every two seconds, as earlier versions did, was 1800 an hour. A streaming day with two idle hours, eight hours of music with the odd pause and skip, and four idle hours after comes to about 4,700 requests instead of 18,000.

The one thing the widget cannot see is other people. The quota is per developer account, so if several streamers share one Client ID their requests add up. For a shared app, raise `poll_interval_max` for everyone, or give each person their own app. The Troubleshooting test on the setup page uses three requests.

### Using it on a friend's stream (another Spotify account)

Each streamer needs their **own** `settings.txt`, made by logging in with their own Spotify account on their own machine. A `settings.txt` cannot be shared: the token inside is used up the first time a widget refreshes it, and it shows what *that account* is playing, not what the machine is playing.

There are two ways to set a friend up:

**They create their own Spotify app** (their own Client ID). Since February 2026 this requires **their own Spotify Premium**; without it the app does not work even though the setup page hands out a token. In the app's settings they need the Redirect URI `http://127.0.0.1:8888/callback` and **Web API** ticked. Then they run the setup (`setup-spotify.bat` / `.sh`) with their Client ID exactly as in the steps above.

**They use your app** (your Client ID). A development-mode app only serves the owner and the accounts the owner has listed: open [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), open the app, go to **Settings → User Management**, and add their name and the email of their Spotify account (up to five users on new apps; your Premium has to stay active). Then they run the setup (`setup-spotify.bat` / `.sh`) with **your** Client ID while logged in to **their** Spotify account.

Either way, the setup page checks the account at the end of Step 3 and shows what Spotify answered, including what is currently playing. If a widget still shows "Nothing playing" with a reason underneath, open the setup page (`setup-spotify.bat` / `.sh`), load (or paste) that `settings.txt` into the **Troubleshooting** box, and test it: the page does exactly what the widget does and prints Spotify's answers. Testing uses the token up, so save the updated file the test hands back; the Save button writes it straight into the widget folder.

If you tried someone else's `settings.txt` on your own machine, just put your own file back. The widget keeps a separate saved login for each `settings.txt` token, so yours resumes where it left off.

If an account is not on the list, Spotify answers every request with "User not registered in the Developer Dashboard", and the widget shows "Nothing playing / Spotify: this account is not added to the app". Once the account is added the widget starts working on its next retry; no need to redo the setup.

### settings.txt options

| Key | Meaning |
|---|---|
| `source` | `auto` (Spotify API if credentials work, else Snip files), `spotify` (API only), or `snip` (Snip files only). Not case-sensitive; anything else means `auto`. |
| `spotify_client_id` | From your Spotify Developer app |
| `spotify_refresh_token` | Generated by the setup page |
| `poll_interval` | How quickly a change shows right after something happened, in ms (default and minimum `2000`; lower values are ignored). Track ends are checked on time regardless. See [Rate limits](#rate-limits-and-the-request-quota) |
| `poll_interval_max` | The longest gap between checks while a track plays undisturbed, in ms (default `8000`; never below `poll_interval`). Raise it to use fewer requests; a mid-track skip or pause then takes up to this long to show |
| `theme` | The look: `zune` (default), `spotify`, `apple-music`, `ipod`, `xbox`, `basic`, `minimal-rect`, `minimal-square`, `candy`, `pixel` or `space`. See [Files and looks](#files-and-looks) |
| `auto_update` | `on` (default) or `off`. See [Updating](#updating) |
| `update_url` | Where releases are read from; only for a fork |
| `--name=value`, `look.--name=value` | Colours, sizes and position. See [Customization](#customization) |

Lines starting with `#` are comments, and so is ` # ...` after a value. `settings.example.txt` lists every setting with its default.

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
| "Nothing playing / Spotify rate limited, retrying in …" | Too many requests in 30 seconds, usually from another program using the same app. See [Rate limits](#rate-limits-and-the-request-quota) |
| "Nothing playing / Spotify request quota used up, retrying in …" | The development-mode request quota for your developer account is used up; Spotify restores it after some hours. See [Rate limits](#rate-limits-and-the-request-quota) |
| "Nothing playing / Spotify login expired: run setup-spotify again" | Spotify rejected the refresh token: expired after 6 months, revoked, or copied from someone else's settings.txt |
| "Nothing playing / Snip not detected" | `settings.txt` has no Spotify credentials (or says `source=snip`) and `Snip\Snip.txt` was not found next to the widget |
| "Nothing playing / No settings.txt and no Snip files" | Neither file was found next to the widget. Check the file is really named `settings.txt` (Windows may have hidden a second `.txt`) and sits in the same folder as the HTML files |
| "Nothing playing / settings.txt must be saved as UTF-8" | The file was saved with another encoding (Notepad's "Unicode"). Save it again as UTF-8 |
| "Nothing playing / Spotify unreachable", "Spotify login failed (HTTP …)" or "Spotify error (HTTP …)" | Spotify could not be reached or gave an unexpected answer. The widget retries every 30 seconds; the Troubleshooting box on the setup page shows the exact response |

---

## Snip Setup (alternative to the Spotify API)

If you'd rather not use the Spotify API (or want a fallback when offline), the widget still reads Snip's output files. This is used automatically when `settings.txt` is missing, `source=snip`, or the Spotify credentials stop working in `auto` mode.

### File Structure

The widget reads files from a `Snip` folder **next to the HTML file**. The simplest setup is to place the widget files directly in your user home folder (`C:\Users\YourName\`), since that is where Snip outputs by default:

```
C:\Users\YourName\
├── widget-now-playing.html
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
3. Click **Browse** and select `widget-now-playing.html`.
4. Set the resolution to match your canvas:
   - **Width:** `1920`
   - **Height:** `1080`
5. Leave the **Custom CSS** field blank (delete any default CSS OBS puts there).
6. **Uncheck** "Shutdown source when not visible" — keeping it active ensures the widget keeps polling for track changes even when the scene is not displayed.
7. **Check** "Refresh browser when scene becomes active" — this forces a reload when you switch to the scene.
8. Click **OK**.

The widget appears in the **bottom-left corner** of the scene in the look `theme=` names (Zune by default). Reposition or scale it in OBS as needed; for a second source with a different look, see [Files and looks](#files-and-looks).

> Opening the widget by double-clicking it only shows the placeholder: normal browsers block file reads from a `file://` page, so `settings.txt` and the Snip files cannot be loaded there. Test inside OBS.

---

## Step 3 — Verify It's Working

1. Play a song in Spotify (or whichever player Snip supports).
2. If using Snip, confirm that `Snip\Snip.txt` and `Snip\Snip_artwork.jpg` appear in the correct folder.
3. The widget should display the song title, artist, and album art within a couple of seconds.
4. If the widget shows "Nothing playing" with a reason underneath after a few seconds, no source is providing track data. See the table above and Troubleshooting below.

---

## Updating

Every change to the widget is published as a release, and installed widgets keep up by themselves:

- **In OBS, automatically.** When the widget loads it asks the release site which version is newest (one tiny request, at most once per 10 minutes for all the browser sources in that OBS). If there is a newer one it fetches the page and script (about 120 KB) and runs them in place of the local files, keeping `settings.txt`, your `--name=value` style lines, any values you changed in the file's `:root` block or in the block of the look in use, and OBS's Custom CSS. Nothing is written to disk. Offline, or if anything about the download looks wrong, the local files run as they are.
- **The files in the folder, with one click.** Double-click `update-widget.bat` (Windows) or run `./update-widget.sh` (Linux / macOS, needs Python 3). It downloads the newest `Widget.zip`, copies every file it is about to replace into `backup\<version>\`, and replaces them, leaving `settings.txt` alone and carrying the `:root` block and the looks' blocks of the widget file over into the new one. Run it when the setup page says a newer release is out, or whenever you like: it does nothing when you are already current.
- **Turning it off.** `auto_update=off` in `settings.txt` makes the widget always run the files as they are. A git checkout of the repository never auto-updates (its version is not stamped in), so use `git pull` there.

The update site is the repository's GitHub Pages, published by the same workflow that makes the release. Everyone's OBS runs what the `main` branch publishes, so treat every push to `main` as a release. Opening the widget in a normal browser may swap in the newest page as well; it then shows the same placeholder as before, since browsers cannot read `settings.txt` from a `file://` page.

### Coming from the per-look files

Earlier releases shipped one file per look (`zune-now-playing.html`, `space-now-playing.html`, and so on). Those keep working: in OBS they update themselves into the merged page and, by their file name, keep showing their look. `update-widget` refreshes them in place the same way from its next run on (the helper that runs is the one already in your folder, and the first run replaces it). To tidy up, point the browser source at `widget-now-playing.html`, put `theme=` in `settings.txt`, and delete the old files when convenient. Four size variables were renamed on the way: `--candy-title-size`, `--px-title-size`, `--sp-title-size` and `--mc-title-size` (and their `-artist-size` twins) are now `--title-size` and `--artist-size` in every look.

---

## Customization

### Colors, sizes, position

`widget-now-playing.html` starts with one block per look that holds that look's colors, font sizes, position, and paused look, followed by an empty `:root` block for values of your own — change those values and everything that depends on them updates. The Zune look, for example:

```css
[data-theme="zune"] {
  --accent-rgb:    255, 69, 0;                 /* main accent (bar, glow, rule) as R, G, B */
  --accent-2:      #E60073;                    /* gradient end / art fill tone   */
  --label-rgb:     255, 106, 51;               /* "now playing" label text as R, G, B */
  --title-rgb:     255, 255, 255;              /* track title text as R, G, B    */
  --artist-color:  rgba(255, 255, 255, 0.85);  /* artist name text               */
  --title-size:    38px;                       /* track title font size          */
  --artist-size:   15px;                       /* artist name font size          */
  --bottom:        52px;                       /* distance from the bottom edge  */
  --left:          52px;                       /* distance from the left edge    */
  --paused-filter: grayscale(1) opacity(0.55); /* look while paused              */
  --scroll-width:  420px;                      /* width of the scrolling title area */
}
```

There are two places to set them:

- **`settings.txt`** (recommended): a line `--title-size=40px` sets that variable for every look, and `zune.--accent-rgb=0, 200, 255` sets it for one look only. These lines live next to your credentials, so they survive every update. `settings.example.txt` lists every variable of every look with its default, ready to uncomment.
- **The widget file itself**: edit a look's block, or put a value in the `:root` block to apply it to every look. Values there are kept across updates too (the automatic update carries the `:root` block and the block of the look in use, and `update-widget` merges every block into the new file), but a value set in `settings.txt` wins over both.

The `-rgb` values are plain red, green, blue numbers (0–255) rather than hex so the glows and shadows can be derived from them in every OBS version.

| Variable | Controls |
|---|---|
| `--title-size` / `--artist-size` | Font sizes (every look) |
| `--bottom` / `--left` | Position on the canvas (every look) |
| `--paused-filter` | How the widget looks while paused: gray and faded by default (every look) |
| `--idle-filter` | How it looks while "Nothing playing": the paused look by default; `opacity(0)` hides it until a track starts (every look) |
| `--title-color` / `--artist-color` | Text colors in the zune (artist only), apple-music, ipod, basic, minimal-rect and minimal-square looks |
| `--accent-rgb` | Zune: left accent bar, its glow, the divider rule, and the title glow |
| `--accent-2` | Zune: bottom of the accent bar gradient and the album art background |
| `--label-rgb` / `--title-rgb` | Zune: "now playing" label, and the large title text (their glows follow) |
| `--scroll-width` | Zune: width of the scrolling title area (other looks scroll within their card width) |
| `--green`, `--bg-card`, `--bg-art`, `--text-primary`, `--text-label`, `--text-artist` | Spotify look |
| `--candy-*`, `--px-*`, `--mc-*`, `--sp-*` | Candy, pixel, xbox and space looks; each look's block in the file lists them with a note per line |

### Other settings

| What to change | What to edit |
|---|---|
| Look | `theme` in `settings.txt` (default `zune`). See [Files and looks](#files-and-looks) |
| Poll interval | `poll_interval` and `poll_interval_max` in `settings.txt` (default `2000` and `8000` ms) |
| Automatic updates | `auto_update` in `settings.txt` (default `on`). See [Updating](#updating) |

### Paused and idle looks

The script adds the class `is-paused` to the widget while playback is paused (and while it shows "Nothing playing"), and `is-idle` for the "Nothing playing" state only. While paused the whole widget is grayed out and faded (that is `--paused-filter`) and the equalizer bars freeze; the rest of the look keeps moving. While idle the bars are hidden and every animation in the look stands still, so an idle widget costs OBS nothing. `--idle-filter=opacity(0)` in `settings.txt` hides the whole widget while idle instead; `--paused-filter=none` keeps it in colour while paused.

---

## Troubleshooting

**Widget shows "Nothing playing" with a reason underneath**
- See the table in [What the widget shows when nothing is playing](#what-the-widget-shows-when-nothing-is-playing).
- If using the Spotify API, check `settings.txt` exists next to the HTML file with a valid `spotify_client_id` and `spotify_refresh_token`, and that a song is actually playing.
- If using Snip, open File Explorer and check that `Snip\Snip.txt` exists next to the HTML file and contains text.
- In OBS, right-click the browser source → **Refresh** to force a reload.

**Spotify worked before but the widget now only shows Snip data, or "Nothing playing" while music plays**
- The refresh token has expired (Spotify expires them after 6 months) or the stored login was lost. Run `setup-spotify.bat` / `.sh` again; it writes the new token into `settings.txt`.
- If the app owner's Spotify Premium lapsed, the app stops working until it is renewed.

**A friend's copy shows "Nothing playing" although the setup page said Success**
- Open the setup page (`setup-spotify.bat` / `.sh`), paste their `settings.txt` into the Troubleshooting box, and read Spotify's answer. The usual causes: the app owner has no Spotify Premium (required since February 2026), the account is not listed under the app's User Management, or the `settings.txt` was copied from someone else and its token is already used up. See [Using it on a friend's stream](#using-it-on-a-friends-stream-another-spotify-account).

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
- Long titles scroll automatically. For the Zune look, widen the title area with `zune.--scroll-width=520px` in `settings.txt`; for card-style looks, increase the card `width` in that look's CSS.
