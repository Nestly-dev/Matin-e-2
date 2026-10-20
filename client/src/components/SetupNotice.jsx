import { Link } from "react-router-dom";

// Shown on the browse tabs when movie listings can't load.
export default function SetupNotice({ error }) {
  if (error?.code === "not_configured") {
    return (
      <section className="notice">
        <h2>Connect movie listings</h2>
        <p>Trending and new movies come from TMDB, which needs a free key on the server. Rooms, screen share and movie sync work without it.</p>
        <ol>
          <li>Create a free account at <a href="https://www.themoviedb.org/signup" target="_blank" rel="noreferrer">themoviedb.org</a>, then open Settings → API and request a key.</li>
          <li>Copy the <b>API Read Access Token</b> (the long one).</li>
          <li>On Render, open your service → Environment → add <code>TMDB_READ_TOKEN</code> with that token, and save. Render restarts the app.</li>
        </ol>
        <Link className="btn btn-primary" to="/together">Start a room anyway</Link>
      </section>
    );
  }
  return (
    <section className="notice">
      <h2>Movie listings didn't load</h2>
      <p>{error?.message || "Something went wrong."} Check your connection and reload the page.</p>
      <Link className="btn btn-ghost" to="/together">Start a room anyway</Link>
    </section>
  );
}
