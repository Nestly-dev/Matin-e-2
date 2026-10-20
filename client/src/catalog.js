import { useEffect, useState } from "react";
import { API } from "./socket.js";

// Talks to OUR server's /api/catalog (which talks to TMDB with the secret key).
// Results are kept in memory so switching tabs back and forth is instant.
const memo = new Map();

export class CatalogError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // "not_configured" | "upstream" | "network" | ...
  }
}

export async function fetchCatalog(path) {
  if (memo.has(path)) return memo.get(path);
  const p = (async () => {
    let res;
    try {
      res = await fetch(`${API}/api/catalog${path}`);
    } catch {
      throw new CatalogError("network", "Can't reach the Matinée server.");
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new CatalogError(body.error || "upstream", body.message || "Couldn't load movies.");
    return body;
  })();
  memo.set(path, p);
  p.catch(() => memo.delete(path)); // let failures be retried
  return p;
}

// React hook: { data, error, loading } for one catalog path (null path = do nothing).
export function useCatalog(path) {
  const [state, setState] = useState({ data: null, error: null, loading: !!path });
  useEffect(() => {
    if (!path) return setState({ data: null, error: null, loading: false });
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetchCatalog(path).then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (error) => alive && setState({ data: null, error, loading: false }),
    );
    return () => { alive = false; };
  }, [path]);
  return state;
}

// ---------- Things remembered on this device ----------
const read = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};
const write = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked: fine */ }
  window.dispatchEvent(new Event(`matinee:${key}`));
};
const useStored = (key, fallback) => {
  const [value, setValue] = useState(() => read(key, fallback));
  useEffect(() => {
    const sync = () => setValue(read(key, fallback));
    window.addEventListener(`matinee:${key}`, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(`matinee:${key}`, sync);
      window.removeEventListener("storage", sync);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return value;
};

// "My list": movies and shows saved for later.
const LIST_KEY = "matinee-my-list";
const keyOf = (item) => `${item.type}:${item.id}`;
export function useMyList() {
  const list = useStored(LIST_KEY, []);
  const has = (item) => list.some((x) => keyOf(x) === keyOf(item));
  const toggle = (item) => {
    const cur = read(LIST_KEY, []);
    const next = cur.some((x) => keyOf(x) === keyOf(item))
      ? cur.filter((x) => keyOf(x) !== keyOf(item))
      : [{ id: item.id, type: item.type, title: item.title, year: item.year, rating: item.rating,
           poster: item.poster, posterLg: item.posterLg, backdrop: item.backdrop, backdropSm: item.backdropSm,
           overview: item.overview, genres: item.genres }, ...cur].slice(0, 60);
    write(LIST_KEY, next);
  };
  return { list, has, toggle };
}

// Rooms you've been in recently, so you can get back to them.
const ROOMS_KEY = "matinee-recent-rooms";
export function rememberRoom(roomId, pick) {
  const cur = read(ROOMS_KEY, []).filter((r) => r.roomId !== roomId);
  write(ROOMS_KEY, [{ roomId, title: pick?.title || null, poster: pick?.poster || null, at: Date.now() }, ...cur].slice(0, 6));
}
export const useRecentRooms = () => useStored(ROOMS_KEY, []);

// Open a new room, optionally for a specific movie ("tonight's pick").
export async function createRoom(pick) {
  const res = await fetch(`${API}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pick: pick ? {
      id: pick.id, type: pick.type, title: pick.title, year: pick.year,
      poster: pick.posterLg || pick.poster, backdrop: pick.backdrop,
    } : null }),
  });
  if (!res.ok) throw new Error("Couldn't open a room.");
  return (await res.json()).roomId;
}
