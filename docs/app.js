import { FFmpeg } from "./vendor/ffmpeg/index.js";

// Output is 720x1280 for phones/WhatsApp. All slide artwork is drawn directly on a 720x1280 canvas.
const W = 720, H = 1280, FPS = 30;
// Header-relevant x264 settings copied from the template encode so the slide SPS/PPS are
// byte-identical to the main video and it can be concatenated without re-encoding.
// Only analysis options are lowered for speed (me/subme/trellis/lookahead/partitions/mbtree/aq/psy do not
// change the headers); crf must equal the template's because x264 writes it into the PPS (pic_init_qp).
const X264_LEVEL = "3.1";
const X264_PARAMS = "cabac=1:ref=2:deblock=0,0:8x8dct=1:cqm=flat:chroma-qp-offset=-2:bframes=3:" +
  "b-pyramid=normal:weightb=1:weightp=1:keyint=250:keyint-min=25:open-gop=0:" +
  "me=dia:subme=0:trellis=0:rc-lookahead=0:mbtree=0:partitions=none:mixed-refs=0:b-adapt=0:scenecut=0:" +
  "aq-mode=0:psy=0:crf=24";

const $ = (id) => document.getElementById(id);
const steps = ["step-lock", "step-kind", "step-form", "step-progress", "step-result", "step-error"];
function show(step) { for (const s of steps) $(s).hidden = s !== step; window.scrollTo(0, 0); }

let manifest, key, logTail = [], resultUrl = null;
let mode = "video"; // "video" or "card"
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
    updateLangUI();
    if (manifest.cards?.length) show("step-kind");
    else { $("kind-card-tile").hidden = true; startMode("video"); }
  } catch (ex) {
    err.textContent = ex.message; err.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = "Open the studio";
  }
});

// ---------- video or card ----------
// Both products share the family / language / guest-name form; the card has no RSVP contact.
function startMode(m) {
  mode = m;
  const card = mode === "card";
  $("form-kind").textContent = card ? "Card invite" : "Video invite";
  $("change-kind").hidden = !manifest.cards?.length;
  $("rsvp-block").hidden = card;
  // the card fits up to two lines of name; the video page keeps its original 40-character limit
  for (const id of ["guest", "guest-hi"]) $(id).maxLength = card ? 60 : 40;
  $("generate-btn").textContent = card ? "Create invitation card" : "Create invitation video";
  $("guest-hint").textContent = card ? "Appears under “Dear” on the card." : "Appears as “Dear …” on the invitation page.";
  $("form-error").hidden = true;
  show("step-form");
  if (card) prefetchChosen();
  else warmUp(); // start the engines and fetch the chosen video while the form is filled in
}
$("kind-next").addEventListener("click", () => startMode(document.querySelector('input[name="kind"]:checked')?.value || "video"));
$("change-kind").addEventListener("click", () => {
  document.querySelector(`input[name="kind"][value="${mode}"]`).checked = true;
  show("step-kind");
});

// ---------- form ----------
const CHOICES = {
  rajul: ["Rajul’s family"], dolly: ["Dolly’s family"], en: ["English"], hi: ["हिंदी"],
};
function renderTemplates() {
  const sides = [...new Set(manifest.templates.map((t) => t.side))];
  const langs = [...new Set(manifest.templates.map((t) => t.lang))];
  const group = (box, name, values) => box.replaceChildren(...values.map((v, i) => {
    const label = Object.assign(document.createElement("label"), { className: "tile" });
    const input = Object.assign(document.createElement("input"), { type: "radio", name, value: v, checked: i === 0 });
    const [title, sub] = CHOICES[v] || [v, ""];
    const t = Object.assign(document.createElement("span"), { className: "tile-title", textContent: title });
    label.append(input, t);
    if (sub) label.append(Object.assign(document.createElement("span"), { className: "tile-sub", textContent: sub }));
    return label;
  }));
  group($("side-list"), "side", sides);
  group($("lang-list"), "lang", langs);
  document.querySelectorAll('input[name="lang"]').forEach((r) => r.addEventListener("change", updateLangUI));
  document.querySelectorAll('input[name="side"]').forEach((r) => r.addEventListener("change", () => {
    // follow the chosen side with its own contact, unless a different contact was picked on purpose
    DEFAULT_CONTACT = `p-${r.value}`;
    if (["p-rajul", "p-dolly"].includes($("rsvp-select").value)) renderContacts(DEFAULT_CONTACT);
  }));
  document.querySelectorAll('input[name="side"], input[name="lang"]').forEach((r) => r.addEventListener("change", prefetchChosen));
}
const currentLang = () => document.querySelector('input[name="lang"]:checked')?.value || "en";
function updateLangUI() {
  $("guest-hi-wrap").hidden = currentLang() !== "hi";
  if (currentLang() === "hi") guestHindi.refresh();
  renderContacts($("rsvp-select").value || undefined);
}

// ---------- Hindi names ----------
// Names are transliterated with Google Input Tools (the same engine as the Google Hindi keyboard);
// common invitation words are translated from a small dictionary. The result is always editable.
const HI_WORDS = {
  family: "परिवार", parivar: "परिवार", parivaar: "परिवार", ji: "जी", jee: "जी", mr: "श्री", shri: "श्री", shree: "श्री", sri: "श्री",
  mrs: "श्रीमती", smt: "श्रीमती", ms: "सुश्री", miss: "सुश्री", kumari: "कुमारी", dr: "डॉ.", and: "एवं", "&": "एवं",
  uncle: "अंकल", aunty: "आंटी", auntie: "आंटी", sir: "सर", madam: "मैडम", bhaiya: "भैया", bhai: "भाई", bhabhi: "भाभी",
  didi: "दीदी", sahab: "साहब", saheb: "साहब", mama: "मामा", mami: "मामी", chacha: "चाचा", chachi: "चाची", tau: "ताऊ", tai: "ताई",
  nana: "नाना", nani: "नानी", dada: "दादा", dadi: "दादी", bua: "बुआ", fufa: "फूफा", mausi: "मौसी", mausa: "मौसा", jija: "जीजा",
  friends: "मित्रगण", friend: "मित्र", colleagues: "सहकर्मी", ka: "का", ki: "की", ke: "के",
};
const hiCache = new Map();
function translitWord(w) {
  if (!hiCache.has(w)) {
    const url = `https://inputtools.google.com/request?text=${encodeURIComponent(w)}&itc=hi-t-i0-und&num=1&cp=0&cs=1&ie=utf-8&oe=utf-8`;
    const p = fetch(url).then((r) => r.json()).then((d) => (d?.[0] === "SUCCESS" && d[1]?.[0]?.[1]?.[0]) || null).catch(() => null);
    hiCache.set(w, p);
    p.then((v) => { if (!v) hiCache.delete(w); });
  }
  return hiCache.get(w);
}
// Returns the Hindi text, or null when the translation service can't be reached.
async function toHindi(text) {
  let s = clean(text || ""), tail = "";
  if (!s) return "";
  const fam = /\s*(?:&|and|with)\s+family$/i.exec(s);
  if (fam && fam.index > 0) { s = s.slice(0, fam.index); tail = " सपरिवार"; }
  const out = await Promise.all(s.split(" ").map(async (w) => {
    if (/[\u0900-\u097F]/.test(w) || !/[a-z]/i.test(w)) return w;          // already Hindi, or digits/symbols
    const k = w.toLowerCase().replace(/[.,]+$/, "");
    return HI_WORDS[k] ?? await translitWord(k);
  }));
  return out.includes(null) ? null : out.join(" ") + tail;
}
const debounce = (fn, ms) => { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; };
// Keeps a Hindi field in step with an English one until the person edits the Hindi themselves.
function hindiFollower(src, dst) {
  let edited = false, seq = 0;
  const refresh = async () => {
    if (edited) return;
    const my = ++seq, v = await toHindi(src.value);
    if (my !== seq || edited) return;
    if (v === null) { dst.placeholder = "Type the name in Hindi"; return; }
    dst.value = v;
  };
  const later = debounce(refresh, 350);
  dst.addEventListener("input", () => { edited = dst.value.trim() !== ""; });
  src.addEventListener("input", () => { if (!src.value.trim()) { edited = false; dst.value = ""; } later(); });
  return { refresh, redo() { edited = false; dst.value = ""; return refresh(); }, reset() { edited = false; dst.value = ""; } };
}
const guestHindi = hindiFollower($("guest"), $("guest-hi"));
const contactHindi = hindiFollower($("rsvp-name"), $("rsvp-name-hi"));
$("guest-hi-redo").addEventListener("click", () => guestHindi.redo());

// RSVP contacts: the family contacts are built in; extra ones are saved on this device.
const PRESETS = [
  { id: "p-rajul", name: "Rajul", hi: "राजुल", phone: "+91 82907 34790" },
  { id: "p-dolly", name: "Dolly", hi: "डौली", phone: "+91 84330 66638" },
  { id: "p-swati", name: "Swati", hi: "स्वाति", phone: "+91 73021 57156" },
  { id: "p-sushil", name: "Sushil", hi: "सुशील", phone: "+91 96301 09100" },
];
const CONTACTS_KEY = "invite-studio:rsvp-contacts";
function loadContacts() {
  try { return (JSON.parse(localStorage.getItem(CONTACTS_KEY)) || []).filter((c) => c?.name && c?.phone); } catch { return []; }
}
function contactLabel(c) {
  return currentLang() === "hi" && c.hi ? `${c.name} (${c.hi}) · ${c.phone}` : `${c.name} · ${c.phone}`;
}
function storeContacts(list) {
  try { localStorage.setItem(CONTACTS_KEY, JSON.stringify(list)); } catch { /* private mode: skip saving */ }
}
const currentSide = () => document.querySelector('input[name="side"]:checked')?.value || "rajul";
let DEFAULT_CONTACT = "p-rajul";
function renderContacts(selectId) {
  const sel = $("rsvp-select"), saved = loadContacts();
  const opt = (value, text) => Object.assign(document.createElement("option"), { value, textContent: text });
  const fam = Object.assign(document.createElement("optgroup"), { label: "Family contacts" });
  fam.append(...PRESETS.map((p) => opt(p.id, contactLabel(p))));
  const groups = [fam];
  if (saved.length) {
    const mine = Object.assign(document.createElement("optgroup"), { label: "Saved on this phone" });
    mine.append(...saved.map((c, i) => opt(`s-${i}`, contactLabel(c))));
    groups.push(mine);
  }
  sel.replaceChildren(...groups, opt("__new", "＋ Add another contact"));
  const wanted = selectId ?? (sel.dataset.last || DEFAULT_CONTACT);
  sel.value = [...sel.options].some((o) => o.value === wanted) ? wanted : DEFAULT_CONTACT;
  updateContactUI();
}
function updateContactUI() {
  const v = $("rsvp-select").value;
  $("rsvp-select").dataset.last = v;
  $("new-contact").hidden = v !== "__new";
  $("remove-contact").hidden = !v.startsWith("s-");
  if (v === "__new") setTimeout(() => $("rsvp-name").focus(), 0);
}
$("rsvp-select").addEventListener("change", updateContactUI);
$("remove-contact").addEventListener("click", () => {
  const i = Number($("rsvp-select").value.slice(2));
  storeContacts(loadContacts().filter((_, j) => j !== i));
  renderContacts(DEFAULT_CONTACT);
});

const clean = (s) => s.trim().replace(/\s+/g, " ");
async function readForm() {
  const side = currentSide(), lang = currentLang();
  const pick = $("rsvp-select").value;
  let contact;
  if (pick === "__new") contact = { name: clean($("rsvp-name").value), hi: clean($("rsvp-name-hi").value), phone: clean($("rsvp-phone").value) };
  else if (pick.startsWith("p-")) contact = PRESETS.find((x) => x.id === pick);
  else contact = loadContacts()[Number(pick.slice(2))] || {};
  let guest = clean($("guest").value);
  const list = mode === "card" ? manifest.cards : manifest.templates;
  const templateId = list.find((t) => t.side === side && t.lang === lang)?.id;
  if (!templateId) return [null, "Please choose the family and the language."];
  if (!guest && !(lang === "hi" && clean($("guest-hi").value))) return [null, "Please enter the guest name."];
  if (mode !== "card" && !contact.name) return [null, "Please enter the RSVP contact name."];
  if (lang === "hi") {
    guest = clean($("guest-hi").value) || await toHindi(guest);
    if (!guest) return [null, "Please type the guest name in Hindi."];
    $("guest-hi").value = guest;
    if (mode === "card") return [{ cardId: templateId, guest }, null];
    if (!contact.hi) contact = { ...contact, hi: (await toHindi(contact.name)) || "" };
  }
  if (mode === "card") return [{ cardId: templateId, guest }, null];
  const v = { templateId, guest, rsvpName: lang === "hi" ? contact.hi || contact.name : contact.name, rsvpPhone: contact.phone, contact };
  const digits = (v.rsvpPhone || "").replace(/\D/g, "");
  if (!/^[+\d][\d\s()-]*$/.test(v.rsvpPhone || "") || digits.length < 7 || digits.length > 15)
    return [null, "Please enter a valid phone number (7–15 digits, may start with +)."];
  return [v, null];
}

// Generation starts only from the "Create invitation video" button. Pressing Enter/Go on the keyboard
// just moves to the next field (or closes the keyboard on the last one).
$("invite-form").addEventListener("submit", (e) => e.preventDefault());
$("invite-form").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.target.tagName !== "INPUT" || e.target.type === "checkbox" || e.target.type === "radio") return;
  e.preventDefault();
  const fields = [...$("invite-form").querySelectorAll("input:not([type=radio]):not([type=checkbox]), select")]
    .filter((el) => el.offsetParent !== null);
  const next = fields[fields.indexOf(e.target) + 1];
  if (next) next.focus(); else e.target.blur();
});
let generating = false;
$("generate-btn").addEventListener("click", async (e) => {
  e.preventDefault();
  if (generating) return;
  generating = true;
  try { await startFromForm(); } finally { generating = false; }
});
async function startFromForm() {
  const [values, problem] = await readForm();
  $("form-error").hidden = !problem;
  if (problem) { $("form-error").textContent = problem; return; }
  if (mode === "card") return generateCard(values);
  if ($("rsvp-select").value === "__new" && $("save-contact").checked) {
    const others = loadContacts().filter((c) => c.phone !== values.rsvpPhone);
    const { name, hi, phone } = values.contact;
    storeContacts([{ name, hi, phone }, ...others].slice(0, 12));
    $("rsvp-name").value = ""; $("rsvp-phone").value = ""; contactHindi.reset();
    renderContacts("s-0");
  }
  await generate(values);
}

$("again-btn").addEventListener("click", () => { $("guest").value = ""; guestHindi.reset(); renderContacts(); show("step-form"); $("guest").focus(); });
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

// ---------- ffmpeg engines ----------
// Two independent ffmpeg.wasm instances (each runs in its own worker, i.e. its own CPU core) so the guest
// page and the RSVP page are encoded at the same time. If the second one can't start, everything runs on one.
let wasmUrlPromise = null;
const engines = [null, null];
function getWasmUrl(onProgress) {
  wasmUrlPromise ??= fetchBytes(new URL("vendor/core/ffmpeg-core.wasm", location.href), 32232419, onProgress)
    .then((w) => URL.createObjectURL(new Blob([w], { type: "application/wasm" })));
  wasmUrlPromise.catch(() => { wasmUrlPromise = null; });
  return wasmUrlPromise;
}
function getEngine(i, onProgress = () => {}) {
  if (engines[i]) { engines[i].then(() => onProgress(1)).catch(() => {}); return engines[i]; }
  engines[i] = (async () => {
    const wasmURL = await getWasmUrl(onProgress);
    const ff = new FFmpeg();
    ff.on("log", ({ message }) => { logTail.push(message); if (logTail.length > 60) logTail.shift(); });
    await ff.load({ coreURL: new URL("vendor/core/ffmpeg-core.js", location.href).href, wasmURL });
    ff.loaded = new Set(); // names of the template files already written into this engine
    return ff;
  })();
  engines[i].catch(() => { engines[i] = null; });
  return engines[i];
}
function chosenTemplate() {
  return manifest?.templates.find((t) => t.side === currentSide() && t.lang === currentLang());
}
function warmUp() {
  getEngine(0).then(() => getEngine(1)).catch(() => {});
  prefetchChosen();
}
function prefetchChosen() {
  if (mode === "card") { const c = chosenCard(); if (c) getCardBase(c).catch(() => {}); return; }
  const t = chosenTemplate();
  if (t) for (const k of ["guestBg", "rsvpBg", "partA", "partB", "music"]) getAsset(t, k).catch(() => {});
}

async function getAsset(template, kind, onProgress) {
  const cacheKey = `${template.id}:${kind}`;
  if (!assetCache.has(cacheKey)) {
    const f = template.files[kind];
    const p = (async () => decrypt(f.iv, await fetchBytes(f.path, f.size, (x) => p.onProgress?.(x))))();
    assetCache.set(cacheKey, p);
    p.catch(() => assetCache.delete(cacheKey));
  }
  const p = assetCache.get(cacheKey);
  p.onProgress = onProgress;
  const bytes = await p;
  onProgress?.(1);
  return bytes;
}
async function putFiles(ff, t, files) {
  for (const [kind, name] of files) {
    const tag = `${t.id}:${kind}`;
    if (ff.loaded.has(tag)) continue;
    for (const old of [...ff.loaded].filter((x) => x.endsWith(`:${kind}`))) ff.loaded.delete(old);
    await ff.writeFile(name, await getAsset(t, kind));
    ff.loaded.add(tag);
  }
}

async function run(ff, args, label, durationSeconds, onFraction) {
  const onLog = ({ message }) => {
    const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(message);
    if (m) onFraction(Math.min(1, (+m[1] * 3600 + +m[2] * 60 + +m[3]) / durationSeconds));
  };
  ff.on("log", onLog);
  try {
    const code = await ff.exec(args);
    if (code !== 0) throw new Error(`Video processing failed while “${label.toLowerCase()}” (code ${code}).`);
  } finally { ff.off("log", onLog); }
  onFraction(1);
}

// ---------- slide artwork (approved designs, 720x1280) ----------
const NAVY = "#0e2260", GOLD = "#a07424", INK = "#2f4a3a";
const NAME_FONT = '"Playball", "Kalam", cursive';            // guest name (Kalam covers Devanagari)
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
// Each template gives the free box (top = under the arch ornament, bottom = the first gold divider); the
// largest size that fits is used, on one line if possible, otherwise on two balanced lines.
function guestLayer(t, guest) {
  const [c, ctx] = layer();
  const { cx, top, bottom } = t.guest, maxW = t.guest.maxW || 380, GAP = 8;
  const dearFont = (px) => (t.lang === "hi" ? `400 ${px}px "Noto Serif Devanagari", serif` : `italic 400 ${px}px "Playfair Display", Georgia, serif`);
  const words = guest.split(" ");
  let two = null;
  if (words.length > 1) {
    let k = 1, best = Infinity;
    for (let i = 1; i < words.length; i++) {
      const d = Math.abs(words.slice(0, i).join(" ").length - words.slice(i).join(" ").length);
      if (d < best) { best = d; k = i; }
    }
    two = [words.slice(0, k).join(" "), words.slice(k).join(" ")];
  }
  const fit = (size, lines) => {
    const dearPx = Math.max(20, Math.min(38, Math.round(size * 0.46)));
    ctx.font = nameFont(size);
    const m = lines.map((l) => ctx.measureText(l));
    if (Math.max(...m.map((x) => x.width)) > maxW) return null;
    const lh = Math.round(size * 1.05);
    ctx.font = dearFont(dearPx);
    const dm = ctx.measureText(DEAR_WORD[t.lang]);
    const lastBase = bottom - GAP - m[m.length - 1].actualBoundingBoxDescent;
    const firstBase = lastBase - lh * (lines.length - 1);
    const dearBase = firstBase - m[0].actualBoundingBoxAscent - GAP - dm.actualBoundingBoxDescent;
    if (dearBase - dm.actualBoundingBoxAscent < top) return null;
    return { size, lines, dearPx, firstBase, dearBase, lh };
  };
  let L = null;
  for (let size = 84; size >= 24 && !L; size -= 2) L = fit(size, [guest]) || (two && fit(size, two));
  L ??= fit(24, two || [guest]) || { size: 24, lines: [guest], dearPx: 20, firstBase: bottom - GAP - 6, dearBase: bottom - GAP - 34, lh: 25 };
  ctx.font = dearFont(L.dearPx); ctx.fillStyle = GOLD;
  ctx.fillText(DEAR_WORD[t.lang], cx, L.dearBase);
  ctx.font = nameFont(L.size); ctx.fillStyle = NAVY;
  ctx.shadowColor = "rgba(14,34,96,0.28)"; ctx.shadowOffsetX = 2; ctx.shadowOffsetY = 2; ctx.shadowBlur = 3;
  L.lines.forEach((l, i) => ctx.fillText(l, cx, L.firstBase + i * L.lh));
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

// Trims a full-frame text layer to its ink (even offsets/sizes for 4:2:0) and returns where it goes.
function cropToInk(canvas) {
  const { data } = canvas.getContext("2d").getImageData(0, 0, W, H);
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W * 4;
    for (let x = 0; x < W; x++) if (data[row + x * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
  }
  if (x1 < 0) return { canvas, x: 0, y: 0 };
  x0 = Math.max(0, (x0 - 4) & ~1); y0 = Math.max(0, (y0 - 4) & ~1);
  x1 = Math.min(W, (x1 + 6) & ~1); y1 = Math.min(H, (y1 + 6) & ~1);
  const c = Object.assign(document.createElement("canvas"), { width: x1 - x0, height: y1 - y0 });
  c.getContext("2d").drawImage(canvas, -x0, -y0);
  return { canvas: c, x: x0, y: y0 };
}

const pngBytes = (canvas) => new Promise((resolve, reject) => canvas.toBlob(
  (b) => b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a))) : reject(new Error("Could not render the text.")), "image/png"));

// Overlays a text PNG on a background clip and encodes it with the template-matched x264 settings.
// Each background starts and ends on a 0.8 s crossfade, so the text's 0.8 s alpha ramps exactly follow the
// page fading in/out: the text is printed on the page, never animated on its own.
function slideArgs(bg, png, out, seconds, { x, y, textIn, textOut, frameOut }) {
  const frames = Math.round(seconds * FPS);
  let text = `[1:v]format=yuva420p,loop=loop=-1:size=1,setpts=N/${FPS}/TB,fade=t=in:st=${textIn}:d=0.8:alpha=1`;
  if (textOut != null) text += `,fade=t=out:st=${textOut}:d=0.8:alpha=1`;
  const tail = frameOut != null ? `,fade=t=out:st=${frameOut}:d=0.8` : "";
  return [
    "-i", bg, "-i", png,
    "-filter_complex", `[0:v]setpts=N/${FPS}/TB[b];${text}[t];[b][t]overlay=x=${x}:y=${y}:format=yuv420:eof_action=endall:shortest=1${tail},format=yuv420p,setsar=0[v]`,
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
    const ff = await getEngine(0, (p) => setProgress(p * 0.2, `Loading the video engine… ${Math.round(p * 100)}%`));
    const ff2 = await getEngine(1).catch(() => null);
    mark("engine", t0);

    t0 = performance.now();
    const kinds = ["guestBg", "rsvpBg", "partA", "partB", "music"];
    const sizes = kinds.map((k) => t.files[k].size), total = sizes.reduce((a, b) => a + b, 0), got = {};
    const tick = () => { const f = kinds.reduce((a, k, i) => a + (got[k] || 0) * sizes[i], 0) / total;
      setProgress(0.2 + 0.25 * f, `Loading the ${t.label} video… ${Math.round(f * 100)}%`); };
    await Promise.all(kinds.map((k) => getAsset(t, k, (p) => { got[k] = p; tick(); })));
    const rsvpEngine = ff2 || ff;
    await putFiles(ff, t, [["guestBg", "guestBg.mp4"], ["partA", "partA.mp4"], ["partB", "partB.mp4"], ["music", "music.m4a"]]);
    await putFiles(rsvpEngine, t, [["rsvpBg", "rsvpBg.mp4"]]);
    mark("assets", t0);

    t0 = performance.now();
    setProgress(0.46, "Writing the names");
    await ensureFonts();
    const g = cropToInk(guestLayer(t, values.guest)), r = cropToInk(rsvpLayer(t, values.rsvpName, values.rsvpPhone));
    await ff.writeFile("guest.png", await pngBytes(g.canvas));
    await rsvpEngine.writeFile("rsvp.png", await pngBytes(r.canvas));
    mark("text", t0);

    t0 = performance.now();
    const frac = [0, 0];
    const both = () => setProgress(0.48 + 0.46 * (frac[0] + frac[1]) / 2);
    setProgress(0.48, "Adding the guest name and RSVP details");
    const guestJob = () => run(ff, slideArgs("guestBg.mp4", "guest.png", "guest.mp4", t.guestSeconds,
      { x: g.x, y: g.y, textIn: 0, textOut: t.guestSeconds - 0.8 }), "Adding the guest name", t.guestSeconds, (f) => { frac[0] = f; both(); });
    const rsvpJob = () => run(rsvpEngine, slideArgs("rsvpBg.mp4", "rsvp.png", "rsvp.mp4", t.rsvpSeconds,
      { x: r.x, y: r.y, textIn: 0, frameOut: t.rsvpSeconds - 0.8 }), "Adding the RSVP details", t.rsvpSeconds, (f) => { frac[1] = f; both(); });
    if (ff2) await Promise.all([guestJob(), rsvpJob()]);
    else { await guestJob(); await rsvpJob(); }
    if (ff2) { await ff.writeFile("rsvp.mp4", await ff2.readFile("rsvp.mp4")); await ff2.deleteFile("rsvp.mp4").catch(() => {}); }
    mark("encode", t0);

    t0 = performance.now();
    await ff.writeFile("list.txt", "file partA.mp4\nfile guest.mp4\nfile partB.mp4\nfile rsvp.mp4\n");
    // Video is stream-copied (template parts never re-encoded); the full-length music is muxed over all of it.
    setProgress(0.95, "Joining the video and music");
    await run(ff, ["-f", "concat", "-safe", "0", "-i", "list.txt", "-i", "music.m4a", "-map", "0:v", "-map", "1:a",
      "-c", "copy", "-shortest", "-movflags", "+faststart", "-y", "out.mp4"], "Joining the video and music", t.totalSeconds, () => {});
    const out = await ff.readFile("out.mp4");
    mark("join", t0);
    for (const f of ["guest.png", "rsvp.png", "guest.mp4", "rsvp.mp4", "out.mp4", "list.txt"]) await ff.deleteFile(f).catch(() => {});
    if (ff2) await ff2.deleteFile("rsvp.png").catch(() => {});
    if (!out?.length) throw new Error("The finished video came out empty.");

    setProgress(1, "Done");
    console.log("timings", timings);
    showResult(new Blob([out], { type: "video/mp4" }), values,
      `Wedding-Invitation-${slug(clean($("guest").value) || values.guest)}.mp4`,
      `${(out.length / 1048576).toFixed(1)} MB · ready in ${((performance.now() - started) / 1000).toFixed(1)} s`);
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

// ---------- card invite ----------
// The approved card (2160x3840) is a blank base image with "Dear" / "प्रिय" already printed; the guest name is
// drawn in navy into the box under it, using the approved fitting rules (round 7, guest-fit.js): one line at the
// largest size up to maxSize; below minOne it tries two balanced lines (honorific "जी" kept with the name before
// it) and uses them only if that gives a bigger name; a comma follows the name.
function chosenCard() {
  return manifest?.cards?.find((c) => c.side === currentSide() && c.lang === currentLang());
}
function getCardBase(card, onProgress) {
  return getAsset({ id: card.id, files: { card: card.file } }, "card", onProgress);
}
async function loadCardFont(box, text) {
  const faces = await document.fonts.load(`${box.maxSize}px ${box.font}`, text);
  await document.fonts.ready;
  if (!faces.length) throw new Error("The card lettering could not be loaded. Check the connection and try again.");
}
function drawCardGuest(ctx, box, rawName) {
  const name = rawName.trim().replace(/\s+/g, " ").replace(/[,\s]+$/, "");
  const full = `${name},`;
  const font = (px) => `${px}px ${box.font}`;
  const width = (s, px) => { ctx.font = font(px); return ctx.measureText(s).width; };
  let lines = [full];
  let size = Math.min(box.maxSize, (100 * box.maxW) / width(full, 100));
  if (size < box.minOne) {
    const words = full.split(" ");
    if (words.length >= 2) {
      let best = null;
      for (let i = 1; i < words.length; i++) {
        if (/^(जी|ji),?$/i.test(words[i]) && words.length > 2) continue;
        const a = words.slice(0, i).join(" "), b = words.slice(i).join(" ");
        const w = Math.max(width(a, 100), width(b, 100));
        if (!best || w < best.w) best = { a, b, w };
      }
      const two = Math.min(box.maxTwo, (100 * box.maxW) / best.w);
      if (two > size) { lines = [best.a, best.b]; size = two; }
    }
  }
  size = Math.floor(size);
  ctx.font = font(size);
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = box.color;
  const gap = size * box.lh;
  const ms = lines.map((ln) => ctx.measureText(ln));
  const asc = ms[0].actualBoundingBoxAscent, desc = ms[ms.length - 1].actualBoundingBoxDescent;
  const first = (box.top + box.bottom) / 2 - (asc + gap * (lines.length - 1) + desc) / 2 + asc;
  // centre each line on the ink of the name itself; the trailing comma hangs outside so the name sits under "Dear"
  ctx.textAlign = "left";
  lines.forEach((ln, i) => {
    const m = ctx.measureText(ln.replace(/,$/, ""));
    ctx.fillText(ln, box.cx - (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2, first + i * gap);
  });
  return { lines, size };
}
async function renderCard(card, guest, onProgress) {
  const bytes = await getCardBase(card, onProgress);
  await loadCardFont(card.box, `${guest},`);
  const url = URL.createObjectURL(new Blob([bytes], { type: card.file.type || "image/jpeg" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = Object.assign(document.createElement("canvas"), { width: img.naturalWidth, height: img.naturalHeight });
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const info = drawCardGuest(ctx, card.box, guest);
    const blob = await new Promise((resolve, reject) => c.toBlob(
      (b) => b ? resolve(b) : reject(new Error("Could not create the card image.")), "image/jpeg", 0.92));
    c.width = c.height = 0; // release the canvas memory right away (phones)
    return { blob, info, width: img.naturalWidth, height: img.naturalHeight };
  } finally { URL.revokeObjectURL(url); }
}
async function generateCard(values) {
  const card = manifest.cards.find((c) => c.id === values.cardId);
  const started = performance.now();
  show("step-progress");
  setProgress(0, "Loading the card");
  try {
    const { blob, info, width, height } = await renderCard(card, values.guest,
      (p) => setProgress(p * 0.8, `Loading the ${card.label} card… ${Math.round(p * 100)}%`));
    setProgress(1, "Done");
    console.log("card", card.id, info);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    showResult(blob, values, `Wedding-Invitation-Card-${slug(clean($("guest").value) || values.guest)}.jpg`,
      `${width}×${height} photo · ${(blob.size / 1048576).toFixed(1)} MB · ready in ${seconds} s`);
  } catch (ex) {
    console.error(ex);
    $("error-message").textContent = friendly(ex);
    $("error-log").textContent = String(ex?.stack || ex);
    show("step-error");
  }
}

function slug(s) { return s.normalize("NFC").replace(/[^\p{L}\p{M}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-").slice(0, 40) || "Guest"; }

function showResult(blob, values, filename, meta) {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = URL.createObjectURL(blob);
  const isCard = blob.type.startsWith("image/"), what = isCard ? "card" : "video";
  $("video-frame").hidden = isCard;
  $("card-frame").hidden = !isCard;
  $("hd-tip").hidden = isCard;
  if (isCard) { $("preview").removeAttribute("src"); $("preview").load(); $("card-preview").src = resultUrl; }
  else { $("card-preview").removeAttribute("src"); $("preview").src = resultUrl; }
  const dl = $("download-btn");
  dl.href = resultUrl; dl.download = filename;
  dl.textContent = isCard ? "Download card" : "Download video";
  $("again-btn").textContent = isCard ? "Make another card" : "Make another video";
  $("other-btn").textContent = isCard ? "Make a video invite" : "Make a card invite";
  $("other-btn").hidden = !manifest.cards?.length;
  $("other-btn").onclick = () => {
    $("guest").value = ""; guestHindi.reset(); renderContacts();
    document.querySelector(`input[name="kind"][value="${isCard ? "video" : "card"}"]`).checked = true;
    startMode(isCard ? "video" : "card"); $("guest").focus();
  };
  $("result-guest").textContent = values.guest;
  $("result-meta").textContent = meta;
  const file = new File([blob], filename, { type: blob.type });
  // Websites can't hand a file straight to WhatsApp: on phones the button opens the share sheet with the
  // video/card attached (WhatsApp is picked there); elsewhere the file is saved so it can be attached in WhatsApp.
  const canShareFile = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  $("share-note").hidden = true;
  $("share-btn").onclick = async () => {
    const note = $("share-note");
    if (canShareFile) {
      try { await navigator.share({ files: [file] }); note.hidden = true; return; }
      catch (ex) { if (ex?.name === "AbortError") return; }
    }
    dl.click();
    note.replaceChildren(`The ${what} is saved. `,
      Object.assign(document.createElement("a"), { href: "https://wa.me/", target: "_blank", rel: "noopener", textContent: "Open WhatsApp" }),
      " and attach it from your gallery or downloads.");
    note.hidden = false;
  };
  show("step-result");
}
