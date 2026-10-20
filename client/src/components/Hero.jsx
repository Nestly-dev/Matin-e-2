import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createRoom, useMyList } from "../catalog.js";
import { useOpenDetails } from "./Rows.jsx";

// The big featured movie at the top, framed like the screen in a cinema:
// velvet curtains drawn back at the edges. You pick which of today's top 5 is on screen.
export default function Hero({ items }) {
  const featured = (items || []).filter((i) => i.backdrop).slice(0, 5);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const open = useOpenDetails();
  const { has, toggle } = useMyList();

  if (!featured.length) return <div className="hero hero-empty" />;
  const item = featured[Math.min(index, featured.length - 1)];
  const saved = has(item);

  const watchTogether = async () => {
    setBusy(true);
    try {
      navigate(`/room/${await createRoom(item)}`);
    } catch {
      setBusy(false);
    }
  };

  return (
    <section className="hero" aria-label="Featured today">
      <div className="hero-screen">
        {featured.map((f, i) => (
          <img key={f.id} src={f.backdrop} alt="" className={i === index ? "on" : ""} aria-hidden={i !== index} />
        ))}
      </div>
      <div className="curtain-left" aria-hidden="true" />
      <div className="curtain-right" aria-hidden="true" />

      <div className="hero-copy">
        {item.genres?.length > 0 && (
          <ul className="chips">{item.genres.map((g) => <li key={g}>{g}</li>)}</ul>
        )}
        <h1>{item.title}</h1>
        <p className="hero-meta">
          {item.rating ? <span className="stars">★ {item.rating.toFixed(1)}</span> : null}
          {item.year ? <span>{item.year}</span> : null}
          <span>{item.type === "tv" ? "Series" : "Film"}</span>
        </p>
        {item.overview && <p className="hero-overview">{item.overview}</p>}
        <div className="hero-actions">
          <button className="btn btn-primary btn-lg-inline" onClick={watchTogether} disabled={busy}>
            {busy ? "Opening a room…" : "Watch together"}
          </button>
          <button className="btn btn-glass" onClick={() => open(item)}>More info</button>
          <button className={`icon-toggle ${saved ? "on" : ""}`} onClick={() => toggle(item)}
            aria-pressed={saved} aria-label={saved ? "Remove from My list" : "Add to My list"} title={saved ? "In My list" : "Add to My list"}>
            {saved ? "♥" : "♡"}
          </button>
        </div>
      </div>

      {featured.length > 1 && (
        <div className="hero-picker" role="tablist" aria-label="Today's top picks">
          {featured.map((f, i) => (
            <button key={f.id} role="tab" aria-selected={i === index} className={i === index ? "on" : ""}
              onClick={() => setIndex(i)} title={f.title}>
              <img src={f.backdropSm || f.backdrop} alt="" />
              <span>{f.title}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
