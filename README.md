# Invite Studio (feasibility prototype)

A private, password-protected tool that turns a fixed wedding-invite video into a personalized MP4 for WhatsApp:
an opening slide (guest name + message), then the unchanged main video, then an RSVP slide.

- `docs/` is the static site (GitHub Pages). All video processing runs in the browser with ffmpeg.wasm.
- The slides are encoded with x264 settings that give byte-identical SPS/PPS to the main video, so the
  main video is joined with `-c copy` and never re-encoded.
- `docs/assets/*.bin` are AES-GCM encrypted (PBKDF2 key from the site password). The source videos
  live in `source/` (git-ignored). Re-encrypt with
  `SITE_PASSWORD=... node tools/encrypt-assets.mjs source/assets.json`.

## Invite tracker

`/tracker/` (same studio password) lists every invite made: Rajul or Dolly side, video or card, language, guest,
RSVP contact, first download/share, and a "Sent" tick. The data lives in the Google Sheet "Wedding Invite Tracker"
(tabs Rajul, Dolly, Summary), written by a Google Apps Script web app (`tools/tracker/Code.gs`, deployed as
Web app / Execute as me / Anyone; the real token replaces the placeholder only in the deployed copy).
The web-app URL and token reach browsers only inside `docs/assets/tracker.json`, encrypted with the studio password:
`TRACKER_URL=…/exec TRACKER_TOKEN=… node tools/tracker/configure.mjs` (asks for the password).
The studio logs in the background (`docs/tracker-client.js`) and queues events on the phone when offline.
