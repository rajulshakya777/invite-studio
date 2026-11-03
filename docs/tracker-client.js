// Talks to the invite tracker (a Google Apps Script web app writing to the "Wedding Invite Tracker" sheet).
// Its URL and token live in assets/tracker.json, encrypted with the studio password, so only an unlocked page can
// reach it. Logging never blocks or breaks invite making: events wait in a small queue on this device and are
// sent again on the next try if the network fails.
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const QUEUE_KEY = "invite-studio:tracker-queue";

let config = null, flushing = null;

// key: the AES-GCM key derived from the studio password. Returns true when a tracker is configured.
export async function connectTracker(key, base = "") {
  try {
    const res = await fetch(`${base}assets/tracker.json`, { cache: "no-cache" });
    if (!res.ok) return false;
    const { iv, ct } = await res.json();
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, key, fromB64(ct));
    config = JSON.parse(new TextDecoder().decode(plain));
    return !!config?.url;
  } catch (ex) {
    console.warn("tracker unavailable", ex);
    config = null;
    return false;
  }
}

export async function call(action, data = {}) {
  if (!config) throw new Error("The tracker is not set up.");
  // text/plain keeps this a "simple" request (no CORS preflight, which Apps Script can't answer)
  const res = await fetch(config.url, {
    method: "POST", redirect: "follow",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ ...data, action, token: config.token }),
  });
  if (!res.ok) throw new Error(`Tracker HTTP ${res.status}`);
  const out = await res.json();
  if (!out.ok) throw Object.assign(new Error(out.error || "Tracker error"), { permanent: true });
  return out;
}

function readQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch { return []; }
}
function writeQueue(q) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-200))); } catch { /* storage blocked */ }
}

// Queue an event and try to send everything waiting, in order.
export function track(action, data) {
  writeQueue([...readQueue(), { action, data }]);
  // a flush already running may have read the queue before this event, so run another after it
  return (flushing || Promise.resolve()).then(flushTracker);
}

export function flushTracker() {
  if (!config) return Promise.resolve();
  if (flushing) return flushing;
  // the first await below makes sure `flushing` is assigned before the finally clears it
  flushing = (async () => {
    await null;
    try {
      for (;;) {
        const q = readQueue();
        if (!q.length) break;
        try { await call(q[0].action, q[0].data); }
        catch (ex) {
          if (!ex.permanent) break;             // offline or server busy: keep it for the next try
          console.warn("tracker dropped an event", ex.message, q[0]);
        }
        writeQueue(readQueue().slice(1));
      }
    } finally { flushing = null; }
  })();
  return flushing;
}

export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function deviceName() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? "iPad"
    : /Android/.test(ua) ? "Android" : /Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Other";
  const br = /SamsungBrowser/.test(ua) ? "Samsung" : /Edg\//.test(ua) ? "Edge" : /CriOS|Chrome\//.test(ua) ? "Chrome"
    : /FxiOS|Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "browser";
  return `${os} ${br}`;
}
