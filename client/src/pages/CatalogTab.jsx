import { useState } from "react";
import { useCatalog } from "../catalog.js";
import { Grid, Row } from "../components/Rows.jsx";
import SetupNotice from "../components/SetupNotice.jsx";

const ROWS = {
  movie: [
    ["Popular right now", "/list/popular-movies"],
    ["New in cinemas", "/list/now-playing"],
    ["Coming soon", "/list/upcoming"],
    ["Top rated", "/list/top-movies"],
  ],
  tv: [
    ["Trending this week", "/list/trending-tv"],
    ["Airing this week", "/list/on-air-tv"],
    ["Popular", "/list/popular-tv"],
    ["Top rated", "/list/top-tv"],
  ],
};

// The Movies tab and the TV shows tab: rows by default, or a grid for one genre.
export default function CatalogTab({ type }) {
  const genres = useCatalog("/genres");
  const [genre, setGenre] = useState(null);
  const results = useCatalog(genre ? `/discover/${type}?genre=${genre.id}` : null);
  const label = type === "tv" ? "TV shows" : "Movies";

  return (
    <div className="catalog-page">
      <div className="catalog-head">
        <h1>{label}</h1>
        {genres.data && (
          <div className="genre-bar" role="radiogroup" aria-label={`${label} by genre`}>
            <button role="radio" aria-checked={!genre} className={!genre ? "on" : ""} onClick={() => setGenre(null)}>All</button>
            {genres.data[type].map((g) => (
              <button key={g.id} role="radio" aria-checked={genre?.id === g.id} className={genre?.id === g.id ? "on" : ""}
                onClick={() => setGenre(g)}>{g.name}</button>
            ))}
          </div>
        )}
      </div>

      {genres.error ? (
        <SetupNotice error={genres.error} />
      ) : genre ? (
        <section className="genre-results">
          <h2>{genre.name}</h2>
          {results.loading ? <p className="hint">Loading…</p>
            : results.error ? <p className="hint">Couldn't load {genre.name.toLowerCase()} right now.</p>
            : <Grid items={results.data?.results || []} />}
        </section>
      ) : (
        <div className="rows">
          {ROWS[type].map(([title, path]) => <Row key={path} title={title} path={path} />)}
        </div>
      )}
    </div>
  );
}
