# Zune Now Playing — OBS Widget

A Zune HD-inspired "Now Playing" overlay for OBS Studio. Displays the current song title, artist, and album artwork from Snip's output files.

---

## Requirements

- [OBS Studio](https://obsproject.com/)
- [Snip](https://github.com/dlrudie/Snip/releases) — writes the current track info and artwork to disk

---

## File Structure

The widget reads files from a `Snip` folder **next to the HTML file**. The simplest setup is to place `zune-now-playing.html` directly in your user home folder (`C:\Users\YourName\`), since that is where Snip outputs by default:

```
C:\Users\YourName\
├── zune-now-playing.html
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
4. Set the **Output directory** to the folder that contains `zune-now-playing.html`.  
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
3. Click **Browse** and select `zune-now-playing.html`.
4. Set the resolution to match your canvas:
   - **Width:** `1920`
   - **Height:** `1080`
5. Leave the **Custom CSS** field blank (delete any default CSS OBS puts there).
6. **Uncheck** "Shutdown source when not visible" — keeping it active ensures the widget keeps polling for track changes even when the scene is not displayed.
7. **Check** "Refresh browser when scene becomes active" — this forces a reload when you switch to the scene.
8. Click **OK**.

The widget appears in the **bottom-left corner** of the scene. Reposition or scale it in OBS as needed.

---

## Step 3 — Verify It's Working

1. Play a song in Spotify (or whichever player Snip supports).
2. Confirm that `Snip\Snip.txt` and `Snip\Snip_artwork.jpg` appear in the correct folder.
3. The widget should display the song title, artist, and album art within a couple of seconds.
4. If nothing appears after 3 seconds, the widget enters **demo mode** and cycles through placeholder tracks — see Troubleshooting below.

---

## Demo Mode

If `Snip\Snip.txt` cannot be read, the widget automatically enters demo mode and cycles through placeholder tracks. This is useful for positioning and scaling the widget in OBS before going live. Once Snip starts writing correctly, the widget switches to real data automatically.

---

## Customization

All styling is in the `<style>` block at the top of the HTML file.

| What to change | What to edit |
|---|---|
| Widget position | `bottom` and `left` values in `.zune-widget` |
| Accent color | `#FF4500` (orange) and `#E60073` (pink) throughout |
| Title font size | `font-size` on `.zune-title` (default `38px`) |
| Artist font size | `font-size` on `.zune-artist` (default `15px`) |
| Scroll area width | `width` on `.zune-title-wrap` (default `420px`) |
| Poll interval | `2000` ms in `setInterval(poll, 2000)` in the script |

---

## Troubleshooting

**Widget shows demo tracks instead of real song info**
- Open File Explorer and check that `Snip\Snip.txt` exists next to the HTML file and contains text.
- Confirm Snip is running and a song is playing.
- In OBS, right-click the browser source → **Refresh** to force a reload.

**Artist or title is blank**
- Make sure your Snip track format is set to `%title%$$n%artist%` (with `$$n` as the separator). Without the newline separator the widget may not split the fields correctly.

**Artwork is not showing**
- Confirm **Save album artwork** is enabled in Snip's settings.
- Check that `Snip\Snip_artwork.jpg` exists in the same folder as `Snip.txt`.
- Some tracks (e.g. local files) may not have artwork — the widget falls back to the animated placeholder.

**Song info is not updating when the track changes**
- Make sure Snip is actively running and set to the correct player (Spotify, foobar2000, etc.).
- Right-click the browser source in OBS → **Refresh**.

**Widget is not visible in OBS**
- Confirm the browser source resolution matches your OBS canvas (1920×1080 by default).
- Make sure the browser source is not hidden or behind another source in the scene.

**Text appears cut off**
- Increase the `width` on `.zune-title-wrap` in the CSS if the title area is too narrow. Long titles scroll automatically.
