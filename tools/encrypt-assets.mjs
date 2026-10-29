// Encrypts the private template assets so they can sit on public static hosting.
// Usage: SITE_PASSWORD=... node tools/encrypt-assets.mjs <assets.json>
// assets.json: { "templates": [{ "id", "label", "video", "background", "audio": null | { "sampleRate", "channels" } }] }
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { webcrypto as crypto } from "node:crypto";
import path from "node:path";

const ITERATIONS = 250_000;
const OUT = new URL("../docs/assets/", import.meta.url).pathname;

const password = process.env.SITE_PASSWORD;
if (!password) throw new Error("Set SITE_PASSWORD");
const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const configDir = path.dirname(path.resolve(process.argv[2]));

const salt = crypto.getRandomValues(new Uint8Array(16));
const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
const key = await crypto.subtle.deriveKey(
  { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
  baseKey, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);

const b64 = (u8) => Buffer.from(u8).toString("base64");
async function encrypt(bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
  return { iv: b64(iv), ct };
}

await mkdir(OUT, { recursive: true });
const check = await encrypt(new TextEncoder().encode("ok"));
const manifest = { kdf: { salt: b64(salt), iterations: ITERATIONS }, check: { iv: check.iv, ct: b64(check.ct) }, templates: [] };

for (const t of config.templates) {
  const entry = { id: t.id, label: t.label, audio: t.audio ?? null, files: {} };
  for (const kind of ["video", "background"]) {
    const src = path.resolve(configDir, t[kind]);
    const { iv, ct } = await encrypt(await readFile(src));
    const name = `${t.id}-${kind}.bin`;
    await writeFile(path.join(OUT, name), ct);
    entry.files[kind] = { path: `assets/${name}`, iv, size: ct.length };
    console.log(`encrypted ${src} -> ${name} (${ct.length} bytes)`);
  }
  manifest.templates.push(entry);
}
await writeFile(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("wrote manifest.json");
