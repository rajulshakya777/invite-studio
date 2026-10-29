import { FFmpeg } from "./vendor/ffmpeg/index.js";

const W = 1080, H = 1920, FPS = 30;
const INTRO_SECONDS = 4.5, OUTRO_SECONDS = 5;
// Header-relevant x264 settings copied from the template encode so the slide SPS/PPS are
// byte-identical to the main video and it can be concatenated without re-encoding.
// Only me/subme/trellis/lookahead are lowered for speed (they don't change the headers).
const X264_PARAMS = "cabac=1:ref=2:deblock=0,0:8x8dct=1:cqm=flat:chroma-qp-offset=-2:bframes=3:" +
  "b-pyramid=normal:weightb=1:weightp=1:keyint=250:keyint-min=25:open-gop=0:" +
  "me=dia:subme=1:trellis=0:rc-lookahead=10:crf=21";

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
  const list = $("template-list");
  list.replaceChildren(...manifest.templates.map((t, i) => {
    const label = document.createElement("label");
    const input = Object.assign(document.createElement("input"), { type: "radio", name: "template", value: t.id, checked: i === 0 });
    label.append(input, document.createTextNode(t.label));
    return label;
  }));
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

const updateCount = () => { $("message-count").textContent = $("message").value.length; };
$("message").addEventListener("input", updateCount); updateCount();

function readForm() {
  const v = {
    templateId: document.querySelector('input[name="template"]:checked')?.value,
    guest: $("guest").value.trim().replace(/\s+/g, " "),
    message: $("message").value.trim().replace(/\s+/g, " "),
    rsvpName: $("rsvp-name").value.trim().replace(/\s+/g, " "),
    rsvpPhone: $("rsvp-phone").value.trim().replace(/\s+/g, " "),
  };
  if (!v.guest) return [null, "Please enter the guest name."];
  if (!v.message) return [null, "Please enter an invitation message."];
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

// ---------- slide artwork ----------
const SERIF = '"Cormorant Garamond", "Noto Serif Devanagari", Georgia, serif';
const SCRIPT = '"Great Vibes", "Noto Serif Devanagari", cursive';
const INK = "#2f4a3a", GOLD = "#a67c2e";

async function ensureFonts() {
  const sample = "Aa नमस्ते";
  await Promise.all([
    `400 40px "Great Vibes"`, `400 40px "Cormorant Garamond"`, `italic 400 40px "Cormorant Garamond"`,
    `600 40px "Cormorant Garamond"`, `400 40px "Noto Serif Devanagari"`, `600 40px "Noto Serif Devanagari"`,
  ].map((f) => document.fonts.load(f, sample).catch(() => {})));
}

function wrap(ctx, text, maxWidth) {
  const words = text.split(" "), lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

// Draws text centred at y, shrinking the font until it fits within maxLines lines.
function fitText(ctx, text, { y, font, size, minSize, maxWidth, maxLines, lineHeight, color }) {
  let lines;
  for (; size >= minSize; size -= 2) {
    ctx.font = font(size);
    lines = wrap(ctx, text, maxWidth);
    if (lines.length <= maxLines && lines.every((l) => ctx.measureText(l).width <= maxWidth)) break;
  }
  ctx.fillStyle = color;
  const lh = size * lineHeight;
  lines.forEach((l, i) => ctx.fillText(l, W / 2, y + i * lh));
  return y + (lines.length - 1) * lh;
}

function spaced(ctx, px) { if ("letterSpacing" in ctx) ctx.letterSpacing = `${px}px`; }

function divider(ctx, y) {
  ctx.strokeStyle = GOLD; ctx.fillStyle = GOLD; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(W / 2 - 150, y); ctx.lineTo(W / 2 - 18, y); ctx.moveTo(W / 2 + 18, y); ctx.lineTo(W / 2 + 150, y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(W / 2, y - 9); ctx.lineTo(W / 2 + 9, y); ctx.lineTo(W / 2, y + 9); ctx.lineTo(W / 2 - 9, y); ctx.closePath(); ctx.fill();
}

function textLayer(draw) {
  const c = Object.assign(document.createElement("canvas"), { width: W, height: H });
  const ctx = c.getContext("2d");
  // soft cream glow behind the text keeps it readable over the floral artwork
  const g = ctx.createRadialGradient(W / 2, 640, 60, W / 2, 640, 560);
  g.addColorStop(0, "rgba(251,246,236,0.92)"); g.addColorStop(0.7, "rgba(251,246,236,0.75)"); g.addColorStop(1, "rgba(251,246,236,0)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  draw(ctx);
  return c;
}

function introLayer({ guest, message }) {
  return textLayer((ctx) => {
    spaced(ctx, 6); ctx.font = `600 34px ${SERIF}`; ctx.fillStyle = GOLD;
    ctx.fillText("A SPECIAL INVITATION FOR", W / 2, 330);
    spaced(ctx, 0);
    const end = fitText(ctx, guest, { y: 470, font: (s) => `400 ${s}px ${SCRIPT}`, size: 120, minSize: 64, maxWidth: 760, maxLines: 2, lineHeight: 1.05, color: INK });
    divider(ctx, end + 70);
    fitText(ctx, message, { y: end + 160, font: (s) => `italic 400 ${s}px ${SERIF}`, size: 50, minSize: 34, maxWidth: 740, maxLines: 7, lineHeight: 1.3, color: INK });
  });
}

function outroLayer({ rsvpName, rsvpPhone }) {
  return textLayer((ctx) => {
    spaced(ctx, 12); ctx.font = `600 76px ${SERIF}`; ctx.fillStyle = GOLD;
    ctx.fillText("RSVP", W / 2, 380);
    spaced(ctx, 0);
    divider(ctx, 440);
    ctx.font = `italic 400 46px ${SERIF}`; ctx.fillStyle = INK;
    ctx.fillText("Kindly confirm your presence with", W / 2, 540);
    const end = fitText(ctx, rsvpName, { y: 680, font: (s) => `400 ${s}px ${SCRIPT}`, size: 104, minSize: 60, maxWidth: 760, maxLines: 2, lineHeight: 1.05, color: INK });
    spaced(ctx, 3); ctx.font = `600 64px ${SERIF}`; ctx.fillStyle = INK;
    ctx.fillText(rsvpPhone, W / 2, end + 120);
    spaced(ctx, 0); ctx.font = `italic 400 42px ${SERIF}`; ctx.fillStyle = GOLD;
    ctx.fillText("We look forward to celebrating with you", W / 2, end + 220);
  });
}

async function backgroundCanvas(jpegBytes) {
  const bmp = await createImageBitmap(new Blob([jpegBytes], { type: "image/jpeg" }));
  const c = Object.assign(document.createElement("canvas"), { width: W, height: H });
  c.getContext("2d").drawImage(bmp, 0, 0, W, H);
  return c;
}

const pngBytes = (canvas) => new Promise((resolve, reject) => canvas.toBlob(
  (b) => b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a))) : reject(new Error("Could not render the slide image.")), "image/png"));

function silenceWav(seconds, sampleRate, channels) {
  const frames = Math.ceil(seconds * sampleRate), dataLen = frames * channels * 2;
  const buf = new ArrayBuffer(44 + dataLen), v = new DataView(buf);
  const str = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + dataLen, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, dataLen, true);
  return new Uint8Array(buf);
}

function slideArgs(name, seconds, audio, fadeOutWholeFrame) {
  const fadeText = `fade=t=in:st=0.15:d=0.8:alpha=1${fadeOutWholeFrame ? "" : `,fade=t=out:st=${seconds - 0.6}:d=0.6:alpha=1`}`;
  const tail = fadeOutWholeFrame ? `,fade=t=out:st=${seconds - 0.6}:d=0.6` : "";
  // Decode each PNG once and repeat the frame with the loop filter; `-loop 1` would
  // re-decode both 1080x1920 images for every frame (~7x slower).
  const repeat = `loop=loop=${Math.round(seconds * FPS) - 1}:size=1,setpts=N/${FPS}/TB`;
  return [
    "-i", "bg.png", "-i", `${name}.png`,
    ...(audio ? ["-i", "silence.wav"] : []),
    "-filter_complex", `[0:v]format=yuv420p,${repeat}[b];[1:v]format=yuva420p,${repeat},${fadeText}[t];` +
      `[b][t]overlay=format=yuv420${tail},format=yuv420p,setsar=0[v]`,
    "-map", "[v]", ...(audio ? ["-map", "2:a", "-c:a", "aac", "-b:a", "128k"] : []),
    "-t", String(seconds), "-r", String(FPS),
    "-c:v", "libx264", "-profile:v", "high", "-level:v", "4.0", "-x264-params", X264_PARAMS,
    "-video_track_timescale", "15360", "-y", `${name}.mp4`,
  ];
}

// ---------- generation ----------
async function generate(values) {
  const template = manifest.templates.find((t) => t.id === values.templateId);
  const started = performance.now(), timings = {};
  const mark = (k, t0) => { timings[k] = ((performance.now() - t0) / 1000).toFixed(1); };
  logTail = [];
  show("step-progress");
  setProgress(0, "Loading the video engine");
  try {
    let t0 = performance.now();
    await getEngine((p) => setProgress(p * 0.3, `Loading the video engine… ${Math.round(p * 100)}%`));
    mark("engine", t0);

    t0 = performance.now();
    const video = await getAsset(template, "video", (p) => setProgress(0.3 + p * 0.12, `Loading the main video… ${Math.round(p * 100)}%`));
    const bg = await getAsset(template, "background");
    if (loadedVideoId !== template.id) { await ffmpeg.writeFile("main.mp4", video); loadedVideoId = template.id; }
    mark("assets", t0);

    t0 = performance.now();
    setProgress(0.43, "Designing the slides");
    await ensureFonts();
    await ffmpeg.writeFile("bg.png", await pngBytes(await backgroundCanvas(bg)));
    await ffmpeg.writeFile("intro.png", await pngBytes(introLayer(values)));
    await ffmpeg.writeFile("outro.png", await pngBytes(outroLayer(values)));
    if (template.audio) await ffmpeg.writeFile("silence.wav", silenceWav(OUTRO_SECONDS, template.audio.sampleRate, template.audio.channels));
    mark("slides", t0);

    t0 = performance.now();
    await run(slideArgs("intro", INTRO_SECONDS, template.audio, false), "Creating the opening slide", INTRO_SECONDS, 0.45, 0.68);
    await run(slideArgs("outro", OUTRO_SECONDS, template.audio, true), "Creating the RSVP slide", OUTRO_SECONDS, 0.68, 0.92);
    mark("encode", t0);

    t0 = performance.now();
    await ffmpeg.writeFile("list.txt", "file intro.mp4\nfile main.mp4\nfile outro.mp4\n");
    await run(["-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "-movflags", "+faststart", "-y", "out.mp4"],
      "Joining the video", INTRO_SECONDS + OUTRO_SECONDS + 20, 0.92, 0.99);
    const out = await ffmpeg.readFile("out.mp4");
    mark("join", t0);
    for (const f of ["intro.png", "outro.png", "bg.png", "intro.mp4", "outro.mp4", "out.mp4", "list.txt"]) await ffmpeg.deleteFile(f).catch(() => {});
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

function slug(s) { return s.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 40) || "Guest"; }

function showResult(bytes, values, seconds, timings) {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  const blob = new Blob([bytes], { type: "video/mp4" });
  resultUrl = URL.createObjectURL(blob);
  const filename = `Wedding-Invitation-${slug(values.guest)}.mp4`;
  $("preview").src = resultUrl;
  const dl = $("download-btn");
  dl.href = resultUrl; dl.download = filename;
  $("result-meta").textContent = `${(bytes.length / 1048576).toFixed(1)} MB · made in ${seconds}s ` +
    `(engine ${timings.engine}s, video ${timings.assets}s, slides ${timings.encode}s, join ${timings.join}s)`;
  const file = new File([blob], filename, { type: "video/mp4" });
  const share = $("share-btn");
  share.hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
  share.onclick = () => navigator.share({ files: [file], title: "Wedding invitation" }).catch(() => {});
  show("step-result");
}
