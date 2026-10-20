import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createRoom, useRecentRooms } from "../catalog.js";

const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 60) return m <= 1 ? "just now" : `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
};

// Start or join a room without picking a movie first (e.g. for YouTube via screen share).
export default function TogetherTab() {
  const navigate = useNavigate();
  const recent = useRecentRooms();
  const [name, setName] = useState(() => localStorage.getItem("matinee-name") || "");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const saveName = () => {
    const n = name.trim();
    if (!n) {
      setError("Add your name first, so the room knows who's who.");
      return false;
    }
    localStorage.setItem("matinee-name", n);
    return true;
  };

  const start = async () => {
    setError("");
    if (!saveName()) return;
    setBusy(true);
    try {
      navigate(`/room/${await createRoom(null)}`);
    } catch {
      setError("Couldn't reach the Matinée server. Check your connection and try again.");
      setBusy(false);
    }
  };

  const join = (e) => {
    e.preventDefault();
    setError("");
    if (!saveName()) return;
    const raw = code.trim();
    const id = raw.includes("/room/") ? raw.split("/room/")[1].split(/[?#/]/)[0] : raw;
    if (!id) return setError("Paste a room link or code.");
    navigate(`/room/${id}`);
  };

  return (
    <div className="together">
      <section className="together-intro">
        <h1>Watch together, from two places at once</h1>
        <p className="lede">
          Open a room and send the link. Pick a movie from Home to watch it in full quality on both ends,
          or share any tab (YouTube, a website, anything) while you talk it through.
        </p>
        <ol className="how">
          <li><b>Open a room</b> and send the invite link. No account or download needed.</li>
          <li><b>Choose how to watch.</b> Movie sync plays each person's own copy in full HD. Screen share shows any tab.</li>
          <li><b>Talk while you watch.</b> Turn your mic on; the movie dips while someone speaks.</li>
        </ol>
      </section>

      <div className="ticket">
        <div className="ticket-body">
          <label className="field">
            <span>Your name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Asha" maxLength={24} />
          </label>
          <button className="btn btn-primary btn-lg" onClick={start} disabled={busy}>
            {busy ? "Opening a room…" : "Start a room"}
          </button>
          <div className="divider"><span>or join one</span></div>
          <form className="join" onSubmit={join}>
            <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste a link or code" aria-label="Room link or code" />
            <button className="btn btn-ghost" type="submit">Join</button>
          </form>
          {error && <p className="error">{error}</p>}
        </div>
        <div className="ticket-stub" aria-hidden="true">
          <span>ADMIT</span>
          <strong>2+</strong>
        </div>
      </div>

      {recent.length > 0 && (
        <section className="recent">
          <h2>Your recent rooms</h2>
          <ul>
            {recent.map((r) => (
              <li key={r.roomId}>
                <Link to={`/room/${r.roomId}`}>
                  {r.poster ? <img src={r.poster} alt="" /> : <span className="recent-blank">🍿</span>}
                  <span>
                    <b>{r.title || "Open room"}</b>
                    <small>{r.roomId}, {ago(r.at)}</small>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
