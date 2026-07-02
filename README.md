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

## Usage

1. Open the app (see hosting below, or open `index.html` directly).
2. Tap **Choose .SES files** (or drag & drop on desktop).
3. Review the session summary (rider, vehicle, track, duration, channels).
4. Download **`.VBO`** for RaceChrono, or **`.CSV`**.

To import into RaceChrono Pro: **Sessions → + → Import session**, then pick the `.vbo`.

## Hosting on GitHub Pages

This is a static site with no build step. To publish it:

1. Create a new GitHub repository and push these files (see below).
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source = Deploy from a branch**,
   **Branch = `main`**, folder **`/ (root)`**, and save.
4. Your app will be live at `https://<your-username>.github.io/<repo-name>/`.

First push:

```sh
git init
git add .
git commit -m "PZRacing SES converter"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

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
