# PZRacing SES Converter

> ⚠️ **Disclaimer:** This is a test/hobby project provided **as-is**, with no
> warranty of any kind. The author accepts **no liability** for any use of this
> tool or its output.

A browser-based tool that converts **PZRacing** data-logger session files (`.SES`)
into formats you can use elsewhere:

- **`.vbo`** — RaceLogic VBOX format, for importing into **RaceChrono Pro**
  (with a start/finish line so the track is auto-detected on import).
- **`.csv`** — a plain, spreadsheet-friendly dump of every channel.

Everything runs **entirely in your browser**. Files are parsed locally and never
uploaded anywhere, so it works offline and keeps your telemetry private.

**▶ Live app:** https://karthikseeganahalli.github.io/PZRacing-web-App/

## Usage

1. Open the [live app](https://karthikseeganahalli.github.io/PZRacing-web-App/),
   or open `index.html` directly from disk.
2. Tap **Choose .SES files** (or drag & drop on desktop).
3. Review the session summary (rider, vehicle, track, duration, channels).
4. Download **`.VBO`** for RaceChrono, or **`.CSV`**.

To import into RaceChrono Pro: **Sessions → + → Import session**, then pick the `.vbo`.

## Running it yourself

This is a static site with no build step, so you can host or run it anywhere:

- **Hosted:** already live via GitHub Pages at
  https://karthikseeganahalli.github.io/PZRacing-web-App/ (deployed from `main`,
  root folder).
- **Locally:** clone the repo and open `index.html` directly, or serve the
  folder — e.g. `python3 -m http.server` — then visit the printed URL.

To self-host your own copy on GitHub Pages: push the files to a repository, then
enable **Settings → Pages → Deploy from a branch → `main` / `/ (root)`**.

## Project structure

```
.
├── index.html          # Page markup
├── css/
│   └── style.css       # Styles (responsive: desktop + mobile)
├── js/
│   ├── parser.js       # Decodes the binary .SES format
│   ├── exporters.js    # Builds .vbo and .csv output
│   └── app.js          # UI wiring (drag/drop, download)
├── .nojekyll           # Serve files as-is on GitHub Pages
├── LICENSE
└── README.md
```

The scripts are plain `<script>` files (no ES modules or bundler), so the app
also works when you just double-click `index.html` from disk (`file://`).

## About the `.SES` format

PZRacing `.SES` files have an ASCII header (session metadata plus analog-channel
calibration, GPS finish-line and split coordinates) followed by fixed-size 52-byte
big-endian binary records at 50 Hz containing time, GPS position, speed, heading,
RPM, accelerometers, battery/voltage and up to eight calibrated analog channels
(throttle, brake, lambda, suspension, etc.). See
[`js/parser.js`](js/parser.js) for the full field layout.

## License

[MIT](LICENSE)
