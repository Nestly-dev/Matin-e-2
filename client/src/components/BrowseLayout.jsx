import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import DetailSheet from "./DetailSheet.jsx";

// The frame around every browse tab: top bar (tabs + search), the page, and the credits footer.
export default function BrowseLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const [query, setQuery] = useState(() => (location.pathname === "/search" ? params.get("q") || "" : ""));
  const [scrolled, setScrolled] = useState(false);

  // Solid top bar once you scroll past the hero.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Each tab starts at the top.
  useEffect(() => { window.scrollTo(0, 0); }, [location.pathname]);

  const submit = (e) => {
    e.preventDefault();
    const q = query.trim();
    if (q) navigate(`/search?q=${encodeURIComponent(q)}`);
  };

  return (
    <div className="browse">
      <header className={`topbar ${scrolled ? "solid" : ""}`}>
        <Link to="/" className="logo">Matinée<span className="logo-dot">●</span></Link>
        <nav className="tabs" aria-label="Browse">
          <NavLink to="/" end>Home</NavLink>
          <NavLink to="/movies">Movies</NavLink>
          <NavLink to="/tv">TV shows</NavLink>
          <NavLink to="/together">Watch together</NavLink>
        </nav>
        <form className="search" role="search" onSubmit={submit}>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" />
          </svg>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search movies and shows" />
        </form>
      </header>

      <main className="browse-main">
        <Outlet />
      </main>

      <footer className="credits">
        <a href="https://www.themoviedb.org" target="_blank" rel="noreferrer" className="tmdb-link" aria-label="TMDB">
          {/* Put TMDB's official logo file at client/public/tmdb-logo.svg (unchanged); the text shows if it's missing. */}
          <img src="/tmdb-logo.svg" alt="TMDB" height="12" onError={(e) => { e.currentTarget.replaceWith(Object.assign(document.createElement("span"), { textContent: "TMDB" })); }} />
        </a>
        <p>Movie and TV listings and images come from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
      </footer>

      <DetailSheet />
    </div>
  );
}
