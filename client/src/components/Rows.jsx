import { useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useCatalog } from "../catalog.js";

// Remember the item someone clicked, so the details panel can show it instantly
// while the full details load.
export const peek = new Map();

export function useOpenDetails() {
  const [, setParams] = useSearchParams();
  return (item) => {
    peek.set(`${item.type}-${item.id}`, item);
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.set("title", `${item.type}-${item.id}`);
      return next;
    });
  };
}

export function PosterCard({ item, onOpen }) {
  return (
    <button className="poster-card" onClick={() => onOpen(item)}>
      <span className="poster-frame">
        {item.poster
          ? <img src={item.poster} alt="" loading="lazy" />
          : <span className="poster-fallback">{item.title}</span>}
      </span>
      <span className="poster-title">{item.title}</span>
      <span className="poster-meta">
        {item.rating ? <span className="stars">★ {item.rating.toFixed(1)}</span> : null}
        {item.year ? <span>{item.year}</span> : null}
        {item.type === "tv" ? <span className="kind">Series</span> : null}
      </span>
    </button>
  );
}

// A titled, horizontally scrolling row. Give it a catalog path, or ready-made items.
export function Row({ title, path, items: given, note }) {
  const { data, loading, error } = useCatalog(given ? null : path);
  const scroller = useRef(null);
  const open = useOpenDetails();
  const items = given || data?.results || [];

  if (error) return null; // the page shows one notice for the whole catalog instead
  if (!loading && items.length === 0) return null;

  const nudge = (dir) => {
    const el = scroller.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: "smooth" });
  };

  return (
    <section className="row" aria-label={title}>
      <div className="row-head">
        <h2>{title}</h2>
        {note && <span className="row-note">{note}</span>}
        <div className="row-arrows">
          <button onClick={() => nudge(-1)} aria-label={`Scroll ${title} left`}>‹</button>
          <button onClick={() => nudge(1)} aria-label={`Scroll ${title} right`}>›</button>
        </div>
      </div>
      <div className="row-track" ref={scroller}>
        {loading
          ? Array.from({ length: 8 }, (_, i) => <span key={i} className="poster-card skeleton"><span className="poster-frame" /></span>)
          : items.map((item) => <PosterCard key={`${item.type}-${item.id}`} item={item} onOpen={open} />)}
      </div>
    </section>
  );
}

// A wrapping grid (genre results, search results, My list).
export function Grid({ items }) {
  const open = useOpenDetails();
  return (
    <div className="poster-grid">
      {items.map((item) => <PosterCard key={`${item.type}-${item.id}`} item={item} onOpen={open} />)}
    </div>
  );
}
