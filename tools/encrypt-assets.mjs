// Encrypts the private template assets so they can sit on public static hosting.
// Usage: SITE_PASSWORD=... node tools/encrypt-assets.mjs <assets.json>
// assets.json: { "templates": [{ "id", "label", "side", "lang", "guest": {cx, cy}, "meta": "<meta.json>",
//                                "files": { "partA", "partB", "guestBg", "rsvpBg", "music" } }],
//                "cards": [ ...card entries... ] | "<cards.json>" }
// partA/partB: silent, pre-encoded with the x264 header settings in docs/app.js (crf must match);
// guestBg/rsvpBg: high-quality backgrounds the site overlays the names on; music: AAC covering the full output length.
// cards (optional): { "id", "label", "side", "lang", "image": "<base.jpg>", "box": { cx, top, bottom, maxW, color,
//                     font, maxSize, minOne, maxTwo, lh, width, height } } - the blank card the guest name is drawn on.
//
// KEEP_MANIFEST=<existing manifest.json>: keep that manifest's key (salt) and its video templates exactly as they are
// (their .bin files are not touched) and only (re)encrypt the cards. The password must match the existing one.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { webcrypto as crypto } from "node:crypto";
import path from "node:path";

const ITERATIONS = 250_000;
const OUT = process.env.OUT_DIR || new URL("../docs/assets/", import.meta.url).pathname;

const password = process.env.SITE_PASSWORD;
if (!password) throw new Error("Set SITE_PASSWORD");
const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const configDir = path.dirname(path.resolve(process.argv[2]));
const keep = process.env.KEEP_MANIFEST ? JSON.parse(await readFile(process.env.KEEP_MANIFEST, "utf8")) : null;

const b64 = (u8) => Buffer.from(u8).toString("base64");
const fromB64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
const salt = keep ? fromB64(keep.kdf.salt) : crypto.getRandomValues(new Uint8Array(16));
const iterations = keep ? keep.kdf.iterations : ITERATIONS;
const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
const key = await crypto.subtle.deriveKey(
  { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
  baseKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);

async function encrypt(bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
  return { iv: b64(iv), ct };
}

await mkdir(OUT, { recursive: true });
let manifest;
if (keep) {
  try { await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(keep.check.iv) }, key, fromB64(keep.check.ct)); }
  catch { throw new Error("SITE_PASSWORD does not match the password of KEEP_MANIFEST"); }
  manifest = { kdf: keep.kdf, check: keep.check, templates: keep.templates };
  console.log(`kept the key and ${keep.templates.length} video templates of ${process.env.KEEP_MANIFEST}`);
} else {
  const check = await encrypt(new TextEncoder().encode("ok"));
  manifest = { kdf: { salt: b64(salt), iterations }, check: { iv: check.iv, ct: b64(check.ct) }, templates: [] };
  for (const t of config.templates || []) {
    const meta = JSON.parse(await readFile(path.resolve(configDir, t.meta), "utf8"));
    const entry = { id: t.id, label: t.label, side: t.side, lang: t.lang, guest: t.guest,
      totalSeconds: meta.totalSeconds, guestSeconds: meta.guestSeconds, rsvpSeconds: meta.rsvpSeconds, files: {} };
    for (const [kind, file] of Object.entries(t.files)) {
      const src = path.resolve(configDir, file);
      const { iv, ct } = await encrypt(await readFile(src));
      const name = `${t.id}-${kind}.bin`;
      await writeFile(path.join(OUT, name), ct);
      entry.files[kind] = { path: `assets/${name}`, iv, size: ct.length };
      console.log(`encrypted ${src} -> ${name} (${ct.length} bytes)`);
    }
    manifest.templates.push(entry);
  }
}

// Card invites: one blank base image per template; the site draws the guest name on it.
let cards = config.cards || [], cardsDir = configDir;
if (typeof cards === "string") {
  const file = path.resolve(configDir, cards);
  cards = JSON.parse(await readFile(file, "utf8")).cards;
  cardsDir = path.dirname(file);
}
manifest.cards = [];
for (const c of cards) {
  const src = path.resolve(cardsDir, c.image);
  const { iv, ct } = await encrypt(await readFile(src));
  const name = `${c.id}-card.bin`;
  await writeFile(path.join(OUT, name), ct);
  manifest.cards.push({ id: c.id, label: c.label, side: c.side, lang: c.lang, box: c.box,
    file: { path: `assets/${name}`, iv, size: ct.length, type: c.type || "image/jpeg" } });
  console.log(`encrypted ${src} -> ${name} (${ct.length} bytes)`);
}
if (!manifest.cards.length) delete manifest.cards;

await writeFile(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("wrote manifest.json");
