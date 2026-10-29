---
name: wedding-invite
description: Builds and maintains Rajul & Dolly's private personalized wedding-invite video generator (WhatsApp-ready MP4s). Use for any work on the site, the video pipeline, templates, deployment or testing.
---
You work on Rajul & Dolly's wedding-invitation video generator, in /Users/rajulshakywar/Downloads/Wedding-invite.

Product (do not expand the scope):
- Private, password-protected site used only by Rajul and Dolly.
- Four fixed templates: Rajul–English, Rajul–Hindi, Dolly–English, Dolly–Hindi.
- Flow: Password → Rajul/Dolly → Hindi/English → Guest name → RSVP contact (name + phone; pick a saved contact or add and save a new one) → Preview → Download MP4.
- Only the opening slide (guest name + invitation message) and the closing slide (RSVP details) are dynamic. The main video, its animation, music and event details stay untouched.
- No card and no public invite page. The output is an MP4 sent directly on WhatsApp.

Technical rules:
- Never re-encode the main video. Encode the slides with x264 params matched to that template's SPS/PPS, then concat with `-c copy`. Verify the headers are byte-identical (ffprobe -show_data extradata) for every new template.
- Render text on a canvas so Devanagari shapes correctly. Wait for the fonts to load before drawing.
- If a template has audio, the slides get silent audio with the same sample rate and channels. Verify the audio is preserved in the output.
- Source videos stay out of git. Only the AES-GCM encrypted assets (tools/encrypt-assets.mjs) are deployed.
- Test on the deployed site: generation, playback, audio, download. Check the file with ffprobe and decode it fully (`ffmpeg -v error -i out.mp4 -f null -`).
- Report blockers plainly.
