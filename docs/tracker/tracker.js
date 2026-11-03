// Invite tracker: unlocks with the studio password, reads every logged invite from the Google Sheet
// (Rajul and Dolly tabs) and lets either of you tick "Sent" after sending it on WhatsApp.
import { connectTracker, call } from "../tracker-client.js";

const $ = (id) => document.getElementById(id);
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

let rows = [], side = "all";

async function unlock(password) {
  const manifest = await fetch("../assets/manifest.json", { cache: "no-cache" }).then((r) => {
    if (!r.ok) throw new Error(`Could not load the site data (HTTP ${r.status}).`);
    return r.json();
  });
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: fromB64(manifest.kdf.salt), iterations: manifest.kdf.iterations, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  try { await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(manifest.check.iv) }, key, fromB64(manifest.check.ct)); }
  catch { throw new Error("Wrong password. Please try again."); }
  if (!(await connectTracker(key, "../"))) throw new Error("The tracker is not set up yet (assets/tracker.json is missing).");
}

$("t-lock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("t-unlock"), err = $("t-lock-error");
  err.hidden = true; btn.disabled = true; btn.textContent = "Checking…";
  try {
    await unlock($("t-password").value);
    $("t-lock").hidden = true; $("t-main").hidden = false;
    await load();
  } catch (ex) {
    err.textContent = ex.message; err.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = "Open the tracker";
  }
});

async function load() {
  $("t-status").textContent = "Loading…";
  try {
    const out = await call("list");
    rows = out.rows || [];
    if (out.sheetUrl) { $("t-sheet").href = out.sheetUrl; $("t-sheet").hidden = false; }
    $("t-status").textContent = `Updated ${new Date().toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}`;
    render();
  } catch (ex) {
    $("t-status").textContent = `Could not load the tracker: ${ex.message}`;
  }
}
$("t-refresh").addEventListener("click", load);

document.querySelectorAll(".t-seg button").forEach((b) => b.addEventListener("click", () => {
  side = b.dataset.side;
  document.querySelectorAll(".t-seg button").forEach((x) => x.classList.toggle("on", x === b));
  render();
}));
for (const id of ["t-search", "t-type", "t-lang"]) $(id).addEventListener("input", render);

const fmt = (iso) => iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";
const norm = (s) => String(s || "").normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});

function render() {
  const q = norm($("t-search").value), type = $("t-type").value, lang = $("t-lang").value;
  // counts on the family buttons ignore the other filters
  for (const b of document.querySelectorAll(".t-seg button")) {
    b.querySelector("span").textContent = b.dataset.side === "all" ? rows.length : rows.filter((r) => r.side === b.dataset.side).length;
  }
  const bySide = rows.filter((r) => side === "all" || r.side === side);
  const shown = bySide.filter((r) => (!type || r.type === type) && (!lang || r.lang === lang) &&
    (!q || norm(r.guest).includes(q) || norm(r.rsvpName).includes(q) || norm(r.rsvpPhone).includes(q)));

  const count = (f) => shown.filter(f).length;
  const stats = [
    [shown.length, "Invites made"], [count((r) => r.type === "Video"), "Videos"], [count((r) => r.type === "Card"), "Cards"],
    [count((r) => r.downloaded), "Downloaded"], [count((r) => r.shared), "Shared"], [count((r) => r.sent), "Marked sent"],
  ];
  $("t-stats").replaceChildren(...stats.map(([n, label]) => {
    const d = el("div", "t-stat"); d.append(el("b", null, String(n)), el("small", null, label)); return d;
  }));

  // the same guest invited more than once (within the shown family)
  const seen = new Map();
  for (const r of bySide) seen.set(norm(r.guest), (seen.get(norm(r.guest)) || 0) + 1);

  const list = $("t-list");
  if (!shown.length) {
    list.replaceChildren(el("li", "t-empty", rows.length ? "No invites match these filters." : "No invites yet. They appear here as soon as one is made in the studio."));
  } else {
    list.replaceChildren(...shown.map(rowItem(seen)));
  }

  // RSVP contacts used, most used first
  const rsvp = new Map();
  for (const r of shown) if (r.rsvpName) {
    const k = `${r.rsvpName}|${r.rsvpPhone}`;
    rsvp.set(k, { name: r.rsvpName, phone: r.rsvpPhone, n: (rsvp.get(k)?.n || 0) + 1 });
  }
  const tr = [...rsvp.values()].sort((a, b) => b.n - a.n).map((c) => {
    const row = el("tr"); row.append(el("td", null, c.name), el("td", null, c.phone), el("td", null, String(c.n))); return row;
  });
  $("t-rsvp").replaceChildren(...(tr.length ? tr : [Object.assign(el("tr"), { innerHTML: '<td colspan="3">No video invites in this view.</td>' })]));
}

const rowItem = (seen) => (r) => {
  const li = el("li", `t-row ${r.side}`);
  const main = el("div");
  const g = el("div", "t-guest", r.guest || "(no name)");
  const dup = seen.get(norm(r.guest));
  if (dup > 1) g.append(el("span", "t-dup", `${dup}×`));
  const meta = el("div", "t-meta", [r.side === "dolly" ? "Dolly" : "Rajul", r.type, r.lang, fmt(r.created), r.device].filter(Boolean).join(" · "));
  main.append(g, meta);
  if (r.rsvpName) {
    const line = el("div", "t-rsvpline", "RSVP: ");
    line.append(el("b", null, r.rsvpName), ` · ${r.rsvpPhone}`);
    main.append(line);
  }
  const chips = el("div", "t-chips");
  chips.append(el("span", `t-chip${r.downloaded ? " yes" : ""}`, r.downloaded ? `Downloaded ${fmt(r.downloaded)}` : "Not downloaded"));
  if (r.shared) chips.append(el("span", "t-chip yes", `Shared ${fmt(r.shared)}`));
  main.append(chips);

  const sent = el("label", "t-sent");
  const box = Object.assign(el("input"), { type: "checkbox", checked: !!r.sent, disabled: !r.id });
  box.setAttribute("aria-label", `Sent to ${r.guest}`);
  box.addEventListener("change", async () => {
    const want = box.checked;
    box.disabled = true;
    try { await call("mark", { id: r.id, field: "sent", value: want }); r.sent = want; render(); }
    catch (ex) { box.checked = !want; $("t-status").textContent = `Could not save: ${ex.message}`; }
    finally { box.disabled = false; }
  });
  sent.append(box, "Sent");
  li.append(main, sent);
  return li;
};

$("t-password").focus();
