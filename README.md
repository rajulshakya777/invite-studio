# Invite Studio (feasibility prototype)

A private, password-protected tool that turns a fixed wedding-invite video into a personalized MP4 for WhatsApp:
an opening slide (guest name + message), then the unchanged main video, then an RSVP slide.

- `docs/` is the static site (GitHub Pages). All video processing runs in the browser with ffmpeg.wasm.
- The slides are encoded with x264 settings that give byte-identical SPS/PPS to the main video, so the
  main video is joined with `-c copy` and never re-encoded.
- `docs/assets/*.bin` are AES-GCM encrypted (PBKDF2 key from the site password). The source videos
  live in `source/` (git-ignored). Re-encrypt with
  `SITE_PASSWORD=... node tools/encrypt-assets.mjs source/assets.json`.
