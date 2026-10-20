import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { API } from "../socket.js";

export default function Home() {
  const navigate = useNavigate();
  const [name, setName] = useState(() => localStorage.getItem("matinee-name") || "");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const saveName = () => {
    const n = name.trim();
    if (!n) {
      setError("Pop your name in first.");
      return false;
    }
    localStorage.setItem("matinee-name", n);
    return true;
  };

  const createRoom = async () => {
    setError("");
    if (!saveName()) return;
    setBusy(true);
    try {
      const res = await fetch(`${API}/api/rooms`, { method: "POST" });
      const { roomId } = await res.json();
      navigate(`/room/${roomId}`);
    } catch {
      setError("Couldn't reach the server. Is it running?");
      setBusy(false);
    }
  };

  const joinRoom = (e) => {
    e.preventDefault();
    setError("");
    if (!saveName()) return;
    // Accept a full link or just the code.
    const raw = code.trim();
    const id = raw.includes("/room/") ? raw.split("/room/")[1].split(/[?#/]/)[0] : raw;
    if (!id) return setError("Paste a room link or code.");
    navigate(`/room/${id}`);
  };

  return (
    <div className="home">
      <div className="marquee-lights" aria-hidden="true" />
      <header className="home-top">
        <span className="logo">Matinée<span className="logo-dot">●</span></span>
      </header>

      <main className="home-main">
        <section className="hero">
          <p className="eyebrow">Now showing · your couch, two places at once</p>
          <h1>
            Watch movies <em>together</em>,<br /> wherever you both are.
          </h1>
          <p className="lede">
            Open a room, send the link, and share your movie tab. They see the picture and hear the sound,
            live, while you both talk it through in the chat.
          </p>

          <div className="ticket">
            <div className="ticket-body">
              <label className="field">
                <span>Your name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Asha"
                  maxLength={24}
                />
              </label>
              <button className="btn btn-primary btn-lg" onClick={createRoom} disabled={busy}>
                {busy ? "Opening the doors…" : "Start a room"}
              </button>

              <div className="divider"><span>or join one</span></div>

              <form className="join" onSubmit={joinRoom}>
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="Paste a link or code, like velvet-7k2p"
                />
                <button className="btn btn-ghost" type="submit">Join</button>
              </form>
              {error && <p className="error">{error}</p>}
            </div>
            <div className="ticket-stub" aria-hidden="true">
              <span>ADMIT</span>
              <strong>2+</strong>
            </div>
          </div>
        </section>

        <section className="steps">
          <article>
            <span className="step-n">01</span>
            <h3>Open a room</h3>
            <p>You get a private link, like a ticket only your people can use.</p>
          </article>
          <article>
            <span className="step-n">02</span>
            <h3>Send the link</h3>
            <p>Your friend opens it on any device. No account, no download.</p>
          </article>
          <article>
            <span className="step-n">03</span>
            <h3>Share your movie tab</h3>
            <p>Open Stremio Web in Chrome, share that tab, and tick “Share tab audio”.</p>
          </article>
        </section>
      </main>

      <footer className="home-foot">Made for movie nights · built with React, Node & WebRTC</footer>
    </div>
  );
}
