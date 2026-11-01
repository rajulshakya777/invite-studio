import { FFmpeg } from "./vendor/ffmpeg/index.js";

// Output is 720x1280 for phones/WhatsApp. All slide artwork is drawn directly on a 720x1280 canvas.
const W = 720, H = 1280, FPS = 30;
// Header-relevant x264 settings copied from the template encode so the slide SPS/PPS are
// byte-identical to the main video and it can be concatenated without re-encoding.
// Only me/subme/trellis/lookahead are lowered for speed (they don't change the headers);
// crf must equal the template's because x264 writes it into the PPS (pic_init_qp).
const X264_LEVEL = "3.1";
const X264_PARAMS = "cabac=1:ref=2:deblock=0,0:8x8dct=1:cqm=flat:chroma-qp-offset=-2:bframes=3:" +
  "b-pyramid=normal:weightb=1:weightp=1:keyint=250:keyint-min=25:open-gop=0:" +
  "me=dia:subme=1:trellis=0:rc-lookahead=10:crf=28";

const $ = (id) => document.getElementById(id);
const steps = ["step-lock", "step-form", "step-progress", "step-result", "step-error"];
function show(step) { for (const s of steps) $(s).hidden = s !== step; window.scrollTo(0, 0); }

let manifest, key, ffmpeg, loadedVideoId = null, logTail = [], resultUrl = null;
const assetCache = new Map();

// ---------- password / decryption ----------
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: fromB64(manifest.kdf.salt), iterations: manifest.kdf.iterations, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
}

async function decrypt(ivB64, data) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(ivB64) }, key, data));
}

$("lock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("unlock-btn"), err = $("lock-error");
  err.hidden = true; btn.disabled = true; btn.textContent = "Checking…";
  try {
    if (!window.WebAssembly || !crypto?.subtle) throw new Error("This browser is too old. Please use a recent Chrome or Safari.");
    manifest ??= await fetch("assets/manifest.json", { cache: "no-cache" }).then((r) => {
      if (!r.ok) throw new Error(`Could not load the site data (HTTP ${r.status}).`);
      return r.json();
    });
    key = await deriveKey($("password").value);
    try { await decrypt(manifest.check.iv, fromB64(manifest.check.ct)); }
    catch { key = null; throw new Error("Wrong password. Please try again."); }
    renderTemplates();
    renderContacts();
    show("step-form");
    warmUp(); // start downloading the engine while the form is filled in
  } catch (ex) {
    err.textContent = ex.message; err.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = "Unlock";
  }
});

// ---------- form ----------
function renderTemplates() {
  const sides = [...new Set(manifest.templates.map((t) => t.side))];
  const langs = [...new Set(manifest.templates.map((t) => t.lang))];
  const LABEL = { rajul: "Rajul", dolly: "Dolly", en: "English", hi: "हिन्दी (Hindi)" };
  const group = (box, name, values) => box.replaceChildren(...values.map((v, i) => {
    const label = document.createElement("label");
    const input = Object.assign(document.createElement("input"), { type: "radio", name, value: v, checked: i === 0 });
    label.append(input, document.createTextNode(LABEL[v] || v));
    return label;
  }));
  group($("side-list"), "side", sides);
  group($("lang-list"), "lang", langs);
}

const CONTACTS_KEY = "invite-studio:rsvp-contacts";
function loadContacts() {
  try { return JSON.parse(localStorage.getItem(CONTACTS_KEY)) || []; } catch { return []; }
}
function storeContacts(list) {
  try { localStorage.setItem(CONTACTS_KEY, JSON.stringify(list)); } catch { /* private mode: skip saving */ }
}
function renderContacts() {
  const box = $("saved-contacts");
  const contacts = loadContacts();
  box.replaceChildren(...contacts.map((c, i) => {
    const chip = Object.assign(document.createElement("span"), { className: "chip", role: "button", tabIndex: 0 });
    chip.textContent = `${c.name} · ${c.phone}`;
    const pick = () => { $("rsvp-name").value = c.name; $("rsvp-phone").value = c.phone; };
    chip.addEventListener("click", pick);
    chip.addEventListener("keydown", (e) => { if (e.key === "Enter") pick(); });
    const x = Object.assign(document.createElement("button"), { type: "button", className: "x", textContent: "×", title: "Remove" });
    x.addEventListener("click", (e) => { e.stopPropagation(); storeContacts(contacts.filter((_, j) => j !== i)); renderContacts(); });
    chip.append(x);
    return chip;
  }));
  if (!contacts.length) box.replaceChildren(Object.assign(document.createElement("p"), { className: "hint", textContent: "No saved contacts yet." }));
}

function readForm() {
  const side = document.querySelector('input[name="side"]:checked')?.value;
  const lang = document.querySelector('input[name="lang"]:checked')?.value;
  const v = {
    templateId: manifest.templates.find((t) => t.side === side && t.lang === lang)?.id,
    guest: $("guest").value.trim().replace(/\s+/g, " "),
    rsvpName: $("rsvp-name").value.trim().replace(/\s+/g, " "),
    rsvpPhone: $("rsvp-phone").value.trim().replace(/\s+/g, " "),
  };
  if (!v.templateId) return [null, "Please choose Rajul/Dolly and the language."];
  if (!v.guest) return [null, "Please enter the guest name."];
  if (!v.rsvpName) return [null, "Please enter the RSVP contact name."];
  const digits = v.rsvpPhone.replace(/\D/g, "");
  if (!/^[+\d][\d\s()-]*$/.test(v.rsvpPhone) || digits.length < 7 || digits.length > 15)
    return [null, "Please enter a valid phone number (7–15 digits, may start with +)."];
  return [v, null];
}

$("invite-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const [values, problem] = readForm();
  $("form-error").hidden = !problem;
  if (problem) { $("form-error").textContent = problem; return; }
  if ($("save-contact").checked) {
    const others = loadContacts().filter((c) => c.phone !== values.rsvpPhone);
    storeContacts([{ name: values.rsvpName, phone: values.rsvpPhone }, ...others].slice(0, 12));
  }
  await generate(values);
});

$("again-btn").addEventListener("click", () => { renderContacts(); show("step-form"); });
$("retry-btn").addEventListener("click", () => show(key ? "step-form" : "step-lock"));

// ---------- progress ----------
function setProgress(fraction, label) {
  $("progress-fill").style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
  if (label) $("progress-label").textContent = label;
}

async function fetchBytes(url, expectedSize, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed for ${url} (HTTP ${res.status}).`);
  const total = Number(res.headers.get("content-length")) || expectedSize || 0;
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader(), chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress?.(Math.min(1, got / total));
  }
  const out = new Uint8Array(got);
  let off = 0; for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// ---------- ffmpeg engine ----------
let enginePromise = null;
function warmUp() { getEngine(() => {}).catch(() => { enginePromise = null; }); }

function getEngine(onProgress) {
  if (enginePromise) { enginePromise.then(() => onProgress(1)); return enginePromise; }
  enginePromise = (async () => {
    const base = new URL("vendor/core/", location.href);
    const wasm = await fetchBytes(new URL("ffmpeg-core.wasm", base), 32232419, onProgress);
    const wasmURL = URL.createObjectURL(new Blob([wasm], { type: "application/wasm" }));
    const ff = new FFmpeg();
    ff.on("log", ({ message }) => { logTail.push(message); if (logTail.length > 60) logTail.shift(); });
    await ff.load({ coreURL: new URL("ffmpeg-core.js", base).href, wasmURL });
    ffmpeg = ff;
    return ff;
  })();
  enginePromise.catch(() => { enginePromise = null; });
  return enginePromise;
}

async function getAsset(template, kind, onProgress) {
  const cacheKey = `${template.id}:${kind}`;
  if (assetCache.has(cacheKey)) { onProgress?.(1); return assetCache.get(cacheKey); }
  const f = template.files[kind];
  const bytes = await decrypt(f.iv, await fetchBytes(f.path, f.size, onProgress));
  assetCache.set(cacheKey, bytes);
  return bytes;
}

async function run(args, label, durationSeconds, from, to) {
  const onLog = ({ message }) => {
    const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(message);
    if (m) setProgress(from + (to - from) * Math.min(1, (+m[1] * 3600 + +m[2] * 60 + +m[3]) / durationSeconds));
  };
  setProgress(from, label);
  ffmpeg.on("log", onLog);
  try {
    const code = await ffmpeg.exec(args);
    if (code !== 0) throw new Error(`Video processing failed while “${label.toLowerCase()}” (code ${code}).`);
  } finally { ffmpeg.off("log", onLog); }
  setProgress(to);
}

// ---------- slide artwork (approved designs, 720x1280) ----------
const NAVY = "#0e2260", GOLD = "#a07424", INK = "#2f4a3a";
const NAME_FONT = '"Playball", "Kalam", cursive';            // guest name (Kalam covers Devanagari)
const DEAR_FONT = { en: 'italic 400 30px "Playfair Display", Georgia, serif', hi: '400 30px "Noto Serif Devanagari", serif' };
const DEAR_WORD = { en: "Dear", hi: "प्रिय" };
const RSVP_NAME_FONT = '"Great Vibes", "Kalam", cursive';
const CLOSING = {
  en: ['italic 400 28px "Cormorant Garamond", Georgia, serif', "We look forward to celebrating with you"],
  hi: ['400 26px "Noto Serif Devanagari", serif', "आपकी प्रतीक्षा रहेगी"],
};

async function ensureFonts() {
  const sample = "Aa Sharma नमस्ते प्रिय";
  await Promise.all([
    '400 40px "Playball"', 'italic 400 40px "Playfair Display"', '700 40px "Kalam"', '400 40px "Great Vibes"',
    '600 40px "Cormorant Garamond"', 'italic 400 40px "Cormorant Garamond"', '400 40px "Noto Serif Devanagari"',
  ].map((f) => document.fonts.load(f, sample).catch(() => {})));
  await document.fonts.ready;
}

function layer() {
  const c = Object.assign(document.createElement("canvas"), { width: W, height: H });
  const ctx = c.getContext("2d");
  ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  return [c, ctx];
}
const nameFont = (s) => `400 ${s}px ${NAME_FONT}`;   // Playball has one weight; Kalam falls back to its 700 face

// "Dear <guest>" in the empty top of the guest-page arch: gold "Dear", bold navy script name, soft shadow.
function guestLayer(t, guest) {
  const [c, ctx] = layer();
  const { cx, cy } = t.guest, maxW = 330;
  const width = (s, txt) => { ctx.font = nameFont(s); return ctx.measureText(txt).width; };
  let size = 66, lines = [guest];
  while (width(size, guest) > maxW && size > 40) size -= 2;
  const words = guest.split(" ");
  if ((size < 54 || width(size, guest) > maxW) && words.length > 1) {
    let k = 1, best = Infinity;
    for (let i = 1; i < words.length; i++) {
      const d = Math.abs(words.slice(0, i).join(" ").length - words.slice(i).join(" ").length);
      if (d < best) { best = d; k = i; }
    }
    lines = [words.slice(0, k).join(" "), words.slice(k).join(" ")];
    size = 60;
    while (Math.max(...lines.map((l) => width(size, l))) > maxW && size > 34) size -= 2;
  }
  ctx.font = nameFont(size);
  const asc = ctx.measureText("Hg").fontBoundingBoxAscent || size * 0.9;
  const lh = Math.round(size * 1.05), dearH = 30, gap = 16;
  const top = cy - Math.floor((dearH + gap + asc + lh * (lines.length - 1)) / 2);
  ctx.font = DEAR_FONT[t.lang]; ctx.fillStyle = GOLD;
  ctx.fillText(DEAR_WORD[t.lang], cx, top + dearH);
  const base = top + dearH + gap + asc * 0.85;
  ctx.font = nameFont(size); ctx.fillStyle = NAVY;
  ctx.shadowColor = "rgba(14,34,96,0.28)"; ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 2; ctx.shadowBlur = 3;
  lines.forEach((l, i) => ctx.fillText(l, cx, base + i * lh));
  return c;
}

function spacedText(ctx, text, x, y, px) {
  if ("letterSpacing" in ctx) { ctx.letterSpacing = `${px}px`; ctx.fillText(text, x + px / 2, y); ctx.letterSpacing = "0px"; return; }
  ctx.fillText(text, x, y);
}

// RSVP card: the clip already carries the "RSVP / Kindly confirm…" heading; add contact name, phone, closing line.
function rsvpLayer(t, rsvpName, rsvpPhone) {
  const [c, ctx] = layer();
  const cx = W / 2;
  let s = 76;
  ctx.font = `400 ${s}px ${RSVP_NAME_FONT}`;
  while (ctx.measureText(rsvpName).width > 520 && s > 44) { s -= 2; ctx.font = `400 ${s}px ${RSVP_NAME_FONT}`; }
  ctx.fillStyle = INK; ctx.fillText(rsvpName, cx, 560);
  ctx.font = '600 44px "Cormorant Garamond", Georgia, serif';
  spacedText(ctx, rsvpPhone, cx, 645, 2);
  ctx.strokeStyle = GOLD; ctx.fillStyle = GOLD; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(cx - 100, 710); ctx.lineTo(cx - 12, 710); ctx.moveTo(cx + 12, 710); ctx.lineTo(cx + 100, 710); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx, 704); ctx.lineTo(cx + 6, 710); ctx.lineTo(cx, 716); ctx.lineTo(cx - 6, 710); ctx.closePath(); ctx.fill();
  const [font, line] = CLOSING[t.lang];
  ctx.font = font; ctx.fillText(line, cx, 785);
  return c;
}

const pngBytes = (canvas) => new Promise((resolve, reject) => canvas.toBlob(
  (b) => b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a))) : reject(new Error("Could not render the text.")), "image/png"));

// Overlays a text PNG on a background clip and encodes it with the template-matched x264 settings.
function slideArgs(bg, png, out, seconds, { textIn, textOut, frameOut }) {
  const frames = Math.round(seconds * FPS);
  let text = `[1:v]format=yuva420p,loop=loop=-1:size=1,setpts=N/${FPS}/TB,fade=t=in:st=${textIn}:d=0.8:alpha=1`;
  if (textOut != null) text += `,fade=t=out:st=${textOut}:d=0.8:alpha=1`;
  const tail = frameOut != null ? `,fade=t=out:st=${frameOut}:d=0.8` : "";
  return [
    "-i", bg, "-i", png,
    "-filter_complex", `[0:v]setpts=N/${FPS}/TB[b];${text}[t];[b][t]overlay=format=yuv420:eof_action=endall:shortest=1${tail},format=yuv420p,setsar=0[v]`,
    "-map", "[v]", "-frames:v", String(frames),
    "-c:v", "libx264", "-profile:v", "high", "-level:v", X264_LEVEL, "-x264-params", X264_PARAMS,
    "-video_track_timescale", "15360", "-y", out,
  ];
}

// ---------- generation ----------
async function generate(values) {
  const t = manifest.templates.find((x) => x.id === values.templateId);
  const started = performance.now(), timings = {};
  const mark = (k, t0) => { timings[k] = ((performance.now() - t0) / 1000).toFixed(1); };
  logTail = [];
  show("step-progress");
  setProgress(0, "Loading the video engine");
  try {
    let t0 = performance.now();
    await getEngine((p) => setProgress(p * 0.25, `Loading the video engine… ${Math.round(p * 100)}%`));
    mark("engine", t0);

    t0 = performance.now();
    const kinds = ["partB", "guestBg", "partA", "rsvpBg", "music"];
    const sizes = kinds.map((k) => t.files[k].size), total = sizes.reduce((a, b) => a + b, 0);
    let done = 0;
    const bytes = {};
    for (const [i, k] of kinds.entries()) {
      bytes[k] = await getAsset(t, k, (p) => setProgress(0.25 + 0.2 * (done + p * sizes[i]) / total, `Loading the ${t.label} video… ${Math.round(100 * (done + p * sizes[i]) / total)}%`));
      done += sizes[i];
    }
    if (loadedVideoId !== t.id) {
      for (const k of kinds) await ffmpeg.writeFile(`${k}.${k === "music" ? "m4a" : "mp4"}`, bytes[k]);
      loadedVideoId = t.id;
    }
    mark("assets", t0);

    t0 = performance.now();
    setProgress(0.46, "Writing the names");
    await ensureFonts();
    await ffmpeg.writeFile("guest.png", await pngBytes(guestLayer(t, values.guest)));
    await ffmpeg.writeFile("rsvp.png", await pngBytes(rsvpLayer(t, values.rsvpName, values.rsvpPhone)));
    mark("text", t0);

    t0 = performance.now();
    await run(slideArgs("guestBg.mp4", "guest.png", "guest.mp4", t.guestSeconds, { textIn: 0.2, textOut: t.guestSeconds - 0.8 }),
      "Adding the guest name", t.guestSeconds, 0.48, 0.72);
    await run(slideArgs("rsvpBg.mp4", "rsvp.png", "rsvp.mp4", t.rsvpSeconds, { textIn: 0.1, frameOut: t.rsvpSeconds - 0.8 }),
      "Adding the RSVP details", t.rsvpSeconds, 0.72, 0.94);
    mark("encode", t0);

    t0 = performance.now();
    await ffmpeg.writeFile("list.txt", "file partA.mp4\nfile guest.mp4\nfile partB.mp4\nfile rsvp.mp4\n");
    // Video is stream-copied (template parts never re-encoded); the full-length music is muxed over all of it.
    await run(["-f", "concat", "-safe", "0", "-i", "list.txt", "-i", "music.m4a", "-map", "0:v", "-map", "1:a",
      "-c", "copy", "-shortest", "-movflags", "+faststart", "-y", "out.mp4"],
      "Joining the video and music", t.totalSeconds, 0.94, 0.99);
    const out = await ffmpeg.readFile("out.mp4");
    mark("join", t0);
    for (const f of ["guest.png", "rsvp.png", "guest.mp4", "rsvp.mp4", "out.mp4", "list.txt"]) await ffmpeg.deleteFile(f).catch(() => {});
    if (!out?.length) throw new Error("The finished video came out empty.");

    setProgress(1, "Done");
    showResult(out, values, ((performance.now() - started) / 1000).toFixed(1), timings);
  } catch (ex) {
    console.error(ex);
    $("error-message").textContent = friendly(ex);
    $("error-log").textContent = `${ex?.stack || ex}\n\n--- ffmpeg log (last lines) ---\n${logTail.join("\n")}`;
    show("step-error");
  }
}

function friendly(ex) {
  const msg = String(ex?.message || ex);
  if (/memory|OOM|RangeError/i.test(msg)) return "The phone ran out of memory while making the video. Close other apps or tabs and try again, or use a computer.";
  if (/Failed to fetch|NetworkError|Load failed|HTTP/i.test(msg)) return `Network problem: ${msg} Check the connection and try again.`;
  return msg;
}

function slug(s) { return s.normalize("NFC").replace(/[^\p{L}\p{M}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-").slice(0, 40) || "Guest"; }

function showResult(bytes, values, seconds, timings) {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  const blob = new Blob([bytes], { type: "video/mp4" });
  resultUrl = URL.createObjectURL(blob);
  const filename = `Wedding-Invitation-${slug(values.guest)}.mp4`;
  $("preview").src = resultUrl;
  const dl = $("download-btn");
  dl.href = resultUrl; dl.download = filename;
  $("result-meta").textContent = `${(bytes.length / 1048576).toFixed(1)} MB · made in ${seconds}s ` +
    `(engine ${timings.engine}s, video ${timings.assets}s, names ${timings.encode}s, join ${timings.join}s)`;
  const file = new File([blob], filename, { type: "video/mp4" });
  const share = $("share-btn");
  share.hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
  share.onclick = () => navigator.share({ files: [file], title: "Wedding invitation" }).catch(() => {});
  show("step-result");
}
