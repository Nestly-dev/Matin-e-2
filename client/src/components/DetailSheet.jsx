import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { createRoom, useCatalog, useMyList } from "../catalog.js";
import { peek } from "./Rows.jsx";

// Details for one movie or show, opened from any card. Lives in the URL (?title=movie-123),
// so the phone's Back button closes it.
export default function DetailSheet() {
  const [params, setParams] = useSearchParams();
  const key = params.get("title");
  const match = key?.match(/^(movie|tv)-(\d+)$/);
  const { data, error } = useCatalog(match ? `/${match[1]}/${match[2]}` : null);
  const item = data || (key ? peek.get(key) : null);
  const [trailer, setTrailer] = useState(false);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const { has, toggle } = useMyList();
  const closeRef = useRef(null);

  const close = () => {
    setTrailer(false);
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.delete("title");
      return next;
    });
  };

  useEffect(() => {
    if (!match) return;
    setTrailer(false);
    closeRef.current?.focus();
    const onKey = (e) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!match) return null;

  const watchTogether = async () => {
    setBusy(true);
    try {
      navigate(`/room/${await createRoom(item)}`);
    } catch {
      setBusy(false);
    }
  };

  const length = data?.runtime
    ? `${Math.floor(data.runtime / 60) ? `${Math.floor(data.runtime / 60)}h ` : ""}${data.runtime % 60}m`
    : data?.seasons ? `${data.seasons} season${data.seasons > 1 ? "s" : ""}` : null;

  return (
    <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && close()}>
      <article className="sheet" role="dialog" aria-modal="true" aria-label={item?.title || "Details"}>
        <button ref={closeRef} className="sheet-close" onClick={close} aria-label="Close">✕</button>

        <div className="sheet-art">
          {trailer && data?.trailerKey ? (
            <iframe
              src={`https://www.youtube-nocookie.com/embed/${data.trailerKey}?autoplay=1&rel=0`}
              title={`${item?.title} trailer`}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
            />
          ) : item?.backdrop ? (
            <img src={item.backdrop} alt="" />
          ) : null}
        </div>

        {item ? (
          <div className="sheet-body">
            <div className="sheet-main">
              <h2>{item.title}</h2>
              {data?.tagline && <p className="tagline">{data.tagline}</p>}
              <p className="hero-meta">
                {item.rating ? <span className="stars">★ {item.rating.toFixed(1)}</span> : null}
                {item.year ? <span>{item.year}</span> : null}
                {length && <span>{length}</span>}
                <span>{item.type === "tv" ? "Series" : "Film"}</span>
              </p>
              {item.genres?.length > 0 && <ul className="chips">{item.genres.map((g) => <li key={g}>{g}</li>)}</ul>}
              <div className="hero-actions">
                <button className="btn btn-primary btn-lg-inline" onClick={watchTogether} disabled={busy}>
                  {busy ? "Opening a room…" : "Watch together"}
                </button>
                {data?.trailerKey && !trailer && (
                  <button className="btn btn-glass" onClick={() => setTrailer(true)}>Play trailer</button>
                )}
                <button className={`icon-toggle ${has(item) ? "on" : ""}`} onClick={() => toggle(item)}
                  aria-pressed={has(item)} aria-label={has(item) ? "Remove from My list" : "Add to My list"}>
                  {has(item) ? "♥" : "♡"}
                </button>
              </div>
              {item.overview && <p className="sheet-overview">{item.overview}</p>}
              {error && <p className="hint">Couldn't load the full details right now.</p>}
            </div>
            {data?.cast?.length > 0 && (
              <aside className="cast">
                <h3>Cast</h3>
                <ul>
                  {data.cast.map((c) => (
                    <li key={c.name + c.character}>
                      {c.photo ? <img src={c.photo} alt="" loading="lazy" /> : <span className="cast-blank">{c.name[0]}</span>}
                      <span><b>{c.name}</b>{c.character && <small>{c.character}</small>}</span>
                    </li>
                  ))}
                </ul>
              </aside>
            )}
          </div>
        ) : (
          <div className="sheet-body"><p className="hint">{error ? "Couldn't load this title." : "Loading…"}</p></div>
        )}
      </article>
    </div>
  );
}
