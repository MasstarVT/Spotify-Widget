# Zune Now Playing — OBS Widget

A Zune HD-inspired "Now Playing" overlay for OBS Studio. Displays the current song title and artist from a local text file, styled after the classic Microsoft Zune interface.

---

## Requirements

- [OBS Studio](https://obsproject.com/)
- A music player companion app that writes to a text file, such as:
  - [Snip](https://github.com/dlrudie/Snip) (recommended)
  - Any tool that writes song info to a `.txt` file

---

## File Setup

Place both files in the **same folder**:

```
📁 your-folder/
├── zune-now-playing.html
└── snip.txt
```

`snip.txt` is written automatically by your companion app. The widget supports two formats:

**Format A — two lines:**
```
Song Title
Artist Name
```

**Format B — single line:**
```
Artist Name - Song Title
```

---

## OBS Setup

1. Open OBS and add a new **Browser Source** to your scene.
2. Check the **Local file** checkbox.
3. Click **Browse** and select `zune-now-playing.html`.
4. Set the resolution:
   - **Width:** `1920`
   - **Height:** `1080`
5. Check **Shutdown source when not visible** (optional but recommended).
6. Make sure **CSS** in the browser source settings is cleared or left as default.
7. Click **OK**.

The widget will appear in the bottom-left corner of your scene. Position and scale it in OBS as needed.

---

## Snip Setup (Recommended)

1. Download and run [Snip](https://github.com/dlrudie/Snip/releases).
2. In Snip settings, make sure **Save to file** is enabled.
3. Note the output file path (default: `%USERPROFILE%\Snip\Snip.txt`).
4. Either:
   - Copy/rename the output file to `snip.txt` next to the HTML, **or**
   - Change Snip's output path to match the widget's folder and filename.

---

## Demo Mode

If `snip.txt` is not found, the widget automatically enters **demo mode** and cycles through a few placeholder tracks. This is useful for positioning and scaling the widget in OBS before going live.

---

## Customization

All styling is in the `<style>` block at the top of the HTML file.

| Thing to change | What to edit |
|---|---|
| Widget position | `bottom` and `left` values in `.zune-widget` |
| Accent color | `#FF4500` (orange) and `#E60073` (pink) throughout |
| Font size | `font-size` on `.zune-title` (default `38px`) |
| Title scroll area width | `width` on `.zune-title-wrap` (default `420px`) |
| Poll interval | `2000` ms in `setInterval(poll, 2000)` at the bottom of the script |

---

## Troubleshooting

**Widget is not showing up**
- Confirm the browser source resolution is set to 1920×1080.
- Make sure the local file path is correct in OBS.

**Song info is not updating**
- Confirm `snip.txt` is in the same folder as the HTML file.
- Check that your companion app is writing to the file while music plays.
- In OBS, right-click the browser source → **Refresh** to force a reload.

**Text appears cut off**
- Increase the `width` on `.zune-title-wrap` in the CSS. Very long titles will auto-scroll.

**Widget shows demo tracks instead of real songs**
- The HTML file cannot find `snip.txt`. Double-check the filename and folder match exactly.
