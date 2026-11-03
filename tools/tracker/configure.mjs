// Writes docs/assets/tracker.json: the Apps Script web-app URL and token, AES-GCM encrypted with the same
// password-derived key as the template assets (salt and iterations from docs/assets/manifest.json).
// Usage: TRACKER_URL=https://script.google.com/macros/s/.../exec TRACKER_TOKEN=... node tools/tracker/configure.mjs
// The studio password is read from SITE_PASSWORD, or asked for (hidden) when it isn't set.
import { readFile, writeFile } from "node:fs/promises";
import { webcrypto as crypto } from "node:crypto";
import readline from "node:readline";

const ASSETS = new URL("../../docs/assets/", import.meta.url);
const url = process.env.TRACKER_URL, token = process.env.TRACKER_TOKEN;
if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url || "")) throw new Error("Set TRACKER_URL to the web app's /exec URL");
if (!token) throw new Error("Set TRACKER_TOKEN");

async function askHidden(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (s.startsWith(q)) process.stdout.write(q); };
  const answer = await new Promise((res) => rl.question(q, res));
  rl.close(); process.stdout.write("\n");
  return answer;
}
const password = process.env.SITE_PASSWORD || await askHidden("Studio password: ");

const b64 = (u8) => Buffer.from(u8).toString("base64");
const fromB64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
const manifest = JSON.parse(await readFile(new URL("manifest.json", ASSETS), "utf8"));
const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
const key = await crypto.subtle.deriveKey(
  { name: "PBKDF2", salt: fromB64(manifest.kdf.salt), iterations: manifest.kdf.iterations, hash: "SHA-256" },
  base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
try { await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(manifest.check.iv) }, key, fromB64(manifest.check.ct)); }
catch { throw new Error("That is not the studio password (it does not open docs/assets/manifest.json)"); }

const iv = crypto.getRandomValues(new Uint8Array(12));
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key,
  new TextEncoder().encode(JSON.stringify({ url, token }))));
await writeFile(new URL("tracker.json", ASSETS), JSON.stringify({ iv: b64(iv), ct: b64(ct) }) + "\n");
console.log("wrote docs/assets/tracker.json");
