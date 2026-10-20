import { io } from "socket.io-client";

// Same origin in dev (Vite proxies it) and in production (Node serves the app).
// Set VITE_SERVER_URL if you host the frontend and backend separately.
const URL = import.meta.env.VITE_SERVER_URL || undefined;

export const socket = io(URL, {
  autoConnect: false,
  // Keep trying to reconnect forever, quickly at first.
  reconnectionDelay: 500,
  reconnectionDelayMax: 3000,
});
export const API = import.meta.env.VITE_SERVER_URL || "";

// A stable ID for this browser tab. It survives connection blips and page refreshes
// (sessionStorage is per-tab), so the server recognises "the same person came back".
function makeClientId() {
  const fresh = () => (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    let id = sessionStorage.getItem("matinee-client-id");
    if (!id) {
      id = fresh();
      sessionStorage.setItem("matinee-client-id", id);
    }
    return id;
  } catch {
    return fresh(); // storage blocked (private mode etc.): still works, just not across refreshes
  }
}
export const clientId = makeClientId();

// ---------- Shared clock ----------
// Movie sync needs everyone to agree on "now". Laptop clocks can be seconds apart, so we
// measure how far ours is from the server's and correct for it.
let clockOffset = 0; // server time minus our time, in ms
export const serverNow = () => Date.now() + clockOffset;

export async function syncClock() {
  let best = null;
  for (let i = 0; i < 4; i++) {
    const t0 = Date.now();
    const serverTime = await new Promise((resolve) =>
      socket.timeout(3000).emit("time", (err, t) => resolve(err ? null : t)));
    const t1 = Date.now();
    if (serverTime == null) continue;
    // Assume the reply took half the round trip; keep the fastest (most accurate) sample.
    const rtt = t1 - t0;
    if (!best || rtt < best.rtt) best = { rtt, offset: serverTime - (t0 + t1) / 2 };
  }
  if (best) clockOffset = best.offset;
}
socket.on("connect", () => { syncClock(); });
