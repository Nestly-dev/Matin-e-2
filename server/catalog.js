// Movie listings from TMDB (The Movie Database), served through our own server so the
// API key never reaches the browser. Results are cached so we stay well under TMDB's limits
// and pages load fast.
//
// Setup: put ONE of these in the environment (Render: Dashboard → your service → Environment):
//   TMDB_READ_TOKEN = the long "API Read Access Token"   (preferred)
//   TMDB_API_KEY    = the short "API Key"
// Optional: TMDB_REGION = two-letter country code for "in cinemas" / "coming soon" (e.g. RW, US).

const express = require("express");

const API_BASE = process.env.TMDB_API_BASE || "https://api.themoviedb.org/3";
const IMG_BASE = process.env.TMDB_IMAGE_BASE || "https://image.tmdb.org/t/p";
const READ_TOKEN = process.env.TMDB_READ_TOKEN || "";
const API_KEY = process.env.TMDB_API_KEY || "";
const REGION = (process.env.TMDB_REGION || "").toUpperCase();
const LANGUAGE = "en-US";

const configured = () => !!(READ_TOKEN || API_KEY);

// ---------- Cache ----------
const cache = new Map(); // key -> { expires, value | promise }
const MIN = 60 * 1000;

async function cached(key, ttlMs, load) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = load();
  cache.set(key, { expires: Date.now() + ttlMs, value });
  try {
    return await value;
  } catch (e) {
    cache.delete(key); // don't remember failures
    throw e;
  }
}

async function tmdb(path, params = {}) {
  const url = new URL(API_BASE + path);
  url.searchParams.set("language", LANGUAGE);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") url.searchParams.set(k, v);
  const headers = { accept: "application/json" };
  if (READ_TOKEN) headers.authorization = `Bearer ${READ_TOKEN}`;
  else url.searchParams.set("api_key", API_KEY);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    const err = new Error(`TMDB ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ---------- Shaping TMDB's data into what the app needs ----------
const img = (path, size) => (path ? `${IMG_BASE}/${size}${path}` : null);

let genreNames = null;
async function genres() {
  return cached("genres", 12 * 60 * MIN, async () => {
    const [m, t] = await Promise.all([tmdb("/genre/movie/list"), tmdb("/genre/tv/list")]);
    genreNames = new Map([...(m.genres || []), ...(t.genres || [])].map((g) => [g.id, g.name]));
    return { movie: m.genres || [], tv: t.genres || [] };
  });
}

function shapeItem(r, forcedType) {
  const type = forcedType || r.media_type || (r.title ? "movie" : "tv");
  if (type !== "movie" && type !== "tv") return null;
  const date = r.release_date || r.first_air_date || "";
  return {
    id: r.id,
    type,
    title: r.title || r.name || "Untitled",
    year: date ? Number(date.slice(0, 4)) : null,
    date: date || null,
    overview: r.overview || "",
    rating: typeof r.vote_average === "number" ? Math.round(r.vote_average * 10) / 10 : null,
    votes: r.vote_count || 0,
    genres: (r.genre_ids || []).map((id) => genreNames?.get(id)).filter(Boolean).slice(0, 3),
    poster: img(r.poster_path, "w342"),
    posterLg: img(r.poster_path, "w500"),
    backdrop: img(r.backdrop_path, "w1280"),
    backdropSm: img(r.backdrop_path, "w780"),
  };
}

const shapeList = (data, type) => (data.results || []).map((r) => shapeItem(r, type)).filter(Boolean);

// The lists the app can ask for. Anything else is refused (we don't proxy arbitrary TMDB URLs).
const LISTS = {
  "trending-today": { path: "/trending/all/day" },
  "trending-movies": { path: "/trending/movie/week", type: "movie" },
  "trending-tv": { path: "/trending/tv/week", type: "tv" },
  "now-playing": { path: "/movie/now_playing", type: "movie", regional: true },
  upcoming: { path: "/movie/upcoming", type: "movie", regional: true },
  "popular-movies": { path: "/movie/popular", type: "movie" },
  "top-movies": { path: "/movie/top_rated", type: "movie" },
  "popular-tv": { path: "/tv/popular", type: "tv" },
  "top-tv": { path: "/tv/top_rated", type: "tv" },
  "on-air-tv": { path: "/tv/on_the_air", type: "tv" },
};

function shapeDetails(d, type) {
  const base = shapeItem({ ...d, genre_ids: [] }, type);
  const trailer = (d.videos?.results || [])
    .filter((v) => v.site === "YouTube" && (v.type === "Trailer" || v.type === "Teaser"))
    .sort((a, b) => (b.type === "Trailer") - (a.type === "Trailer") || (b.official === true) - (a.official === true))[0];
  return {
    ...base,
    genres: (d.genres || []).map((g) => g.name),
    runtime: d.runtime || d.episode_run_time?.[0] || null,
    seasons: d.number_of_seasons || null,
    tagline: d.tagline || "",
    cast: (d.credits?.cast || []).slice(0, 6).map((c) => ({ name: c.name, character: c.character, photo: img(c.profile_path, "w185") })),
    trailerKey: trailer?.key || null,
  };
}

// ---------- Routes ----------
const router = express.Router();

router.use((req, res, next) => {
  if (!configured()) {
    return res.status(503).json({ error: "not_configured", message: "Movie listings need a TMDB key on the server." });
  }
  next();
});

const fail = (res, e) => {
  console.warn("catalog:", e.message);
  const status = e.status === 404 ? 404 : 502;
  res.status(status).json({ error: status === 404 ? "not_found" : "upstream", message: "Couldn't load movie listings right now." });
};

router.get("/genres", async (req, res) => {
  try { res.json(await genres()); } catch (e) { fail(res, e); }
});

router.get("/list/:name", async (req, res) => {
  const list = LISTS[req.params.name];
  if (!list) return res.status(404).json({ error: "unknown_list" });
  const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), 5);
  try {
    await genres(); // so genre names are available
    const params = { page, ...(list.regional && REGION ? { region: REGION } : {}) };
    const data = await cached(`list:${req.params.name}:${page}`, 30 * MIN, () => tmdb(list.path, params));
    res.json({ results: shapeList(data, list.type) });
  } catch (e) { fail(res, e); }
});

// Movies or shows in one genre, most popular first.
router.get("/discover/:type", async (req, res) => {
  const type = req.params.type === "tv" ? "tv" : "movie";
  const genre = parseInt(req.query.genre, 10);
  if (!genre) return res.status(400).json({ error: "genre_required" });
  try {
    await genres();
    const data = await cached(`discover:${type}:${genre}`, 30 * MIN, () =>
      tmdb(`/discover/${type}`, { with_genres: genre, sort_by: "popularity.desc", "vote_count.gte": 50 }));
    res.json({ results: shapeList(data, type) });
  } catch (e) { fail(res, e); }
});

router.get("/search", async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 100);
  if (!q) return res.json({ results: [] });
  try {
    await genres();
    const data = await cached(`search:${q.toLowerCase()}`, 10 * MIN, () => tmdb("/search/multi", { query: q, include_adult: "false" }));
    res.json({ results: shapeList(data) });
  } catch (e) { fail(res, e); }
});

router.get("/:type(movie|tv)/:id", async (req, res) => {
  const { type } = req.params;
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "bad_id" });
  try {
    const data = await cached(`details:${type}:${id}`, 6 * 60 * MIN, () =>
      tmdb(`/${type}/${id}`, { append_to_response: "videos,credits" }));
    res.json(shapeDetails(data, type));
  } catch (e) { fail(res, e); }
});

// Only accept image links from TMDB's image server (used when a room stores "tonight's pick").
const isTmdbImage = (u) => typeof u === "string" && u.startsWith(IMG_BASE + "/") && u.length < 300;

module.exports = { catalogRouter: router, isTmdbImage, catalogConfigured: configured };
