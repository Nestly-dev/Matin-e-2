import { useCallback, useEffect, useRef, useState } from "react";
import { socket, serverNow, clientId } from "./socket.js";

/**
 * Movie sync: everyone plays their OWN copy of the movie (a file on their computer, or a link),
 * and this keeps all the players at the same moment. Only tiny "play at 1:02:03" messages
 * travel between you, so everyone gets their copy's full quality no matter how slow the upload.
 */

// Where the movie should be right now, according to the room.
export const expectedPosition = (s) =>
  s.playing ? s.position + Math.max(0, serverNow() - s.updatedAt) / 1000 : s.position;

const fmt = (t) => {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = Math.floor(t % 60).toString().padStart(2, "0");
  return h ? `${h}:${m.toString().padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

const isLocalLink = (url) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(url || "");

// .srt subtitles -> .vtt (the format browsers understand): mostly "," -> "." in the timestamps.
function srtToVtt(text) {
  const body = text.replace(/\r/g, "").replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return body.trimStart().startsWith("WEBVTT") ? body : `WEBVTT\n\n${body}`;
}

export default function SyncStage({ sync, duck, floaters, flash, members }) {
  const videoRef = useRef(null);
  const boxRef = useRef(null);
  const hlsRef = useRef(null);
  const syncRef = useRef(sync);
  syncRef.current = sync;

  const [local, setLocal] = useState(null); // { name, src, isFile, url? } — MY copy of the movie
  const [linkDraft, setLinkDraft] = useState("");
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [scrub, setScrub] = useState(null); // position while dragging the seek bar
  const [volume, setVolume] = useState(1);
  const [needsTap, setNeedsTap] = useState(false);
  const [status, setStatus] = useState("idle"); // idle | synced | syncing | waiting | paused
  const [subsUrl, setSubsUrl] = useState(null);
  const [loadError, setLoadError] = useState("");
  const waitingTimer = useRef(null);
  const iPausedForBuffering = useRef(false);

  const source = sync?.source;

  // ---------- Loading my copy ----------
  const loadFile = (file) => {
    if (!file) return;
    setLoadError("");
    setLocal({ name: file.name, src: URL.createObjectURL(file), isFile: true });
  };

  const loadLink = (url) => {
    const u = (url || "").trim();
    if (!/^https?:\/\//i.test(u)) return setLoadError("That doesn't look like a video link (it should start with http).");
    setLoadError("");
    const name = decodeURIComponent(u.split(/[?#]/)[0].split("/").filter(Boolean).pop() || "Video link");
    setLocal({ name, src: u, isFile: false, url: u });
  };

  // When the room's movie is cleared ("New movie"), drop my copy too.
  useEffect(() => {
    if (!source && local) {
      setLocal(null);
      setSubsUrl(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // Attach my copy to the <video>. Streaming playlists (.m3u8) need hls.js in most browsers.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !local) return;
    let cancelled = false;
    hlsRef.current?.destroy();
    hlsRef.current = null;
    const isHls = /\.m3u8(\?|$)/i.test(local.src);
    if (isHls && !v.canPlayType("application/vnd.apple.mpegurl")) {
      import("hls.js").then(({ default: Hls }) => {
        if (cancelled) return;
        if (!Hls.isSupported()) return setLoadError("This browser can't play streaming (.m3u8) links.");
        const hls = new Hls();
        hls.loadSource(local.src);
        hls.attachMedia(v);
        hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) setLoadError("The stream link stopped working."); });
        hlsRef.current = hls;
      });
    } else {
      v.src = local.src;
    }
    return () => {
      cancelled = true;
      if (local.isFile) URL.revokeObjectURL(local.src);
    };
  }, [local]);

  useEffect(() => () => hlsRef.current?.destroy(), []);

  // ---------- Following the room ----------
  // hard = a new instruction from the room (seek if we're off by more than a blink).
  // Otherwise it's the 1-second check: small drift is fixed by playing 5% faster/slower,
  // which nobody notices; big drift (>1s) is fixed by jumping.
  const align = useCallback((hard) => {
    const v = videoRef.current;
    const s = syncRef.current;
    if (!v || !local || !s?.source || v.readyState < 1) return;
    const target = Math.min(expectedPosition(s), (v.duration || Infinity) - 0.25);
    const diff = v.currentTime - target;

    if (!s.playing) {
      if (!v.paused) v.pause();
      v.playbackRate = 1;
      if (Math.abs(diff) > 0.25) v.currentTime = target;
      setStatus(s.reason === "buffering" && s.byId !== clientId ? "waiting" : "paused");
      return;
    }
    if (Math.abs(diff) > (hard ? 0.4 : 1)) {
      v.currentTime = target;
      v.playbackRate = 1;
      setStatus("syncing");
    } else if (Math.abs(diff) > 0.15) {
      v.playbackRate = diff > 0 ? 0.95 : 1.05;
      setStatus("syncing");
    } else {
      v.playbackRate = 1;
      setStatus("synced");
    }
    if (v.paused) v.play().then(() => setNeedsTap(false)).catch(() => setNeedsTap(true));
  }, [local]);

  useEffect(() => { align(true); }, [sync?.updatedAt, sync?.playing, sync?.position, align]);
  useEffect(() => {
    const t = setInterval(() => align(false), 1000);
    return () => clearInterval(t);
  }, [align]);

  // ---------- Things the <video> tells us ----------
  const onLoadedMetadata = () => {
    const v = videoRef.current;
    setDuration(v.duration || 0);
    // First person to load a movie makes it the room's movie.
    const s = syncRef.current;
    if (!s?.source) {
      socket.emit("sync-source", { name: local.name, duration: v.duration, url: local.url || null });
    } else if (!s.source.duration && v.duration) {
      socket.emit("sync-duration", { duration: v.duration });
    }
    align(true);
  };

  const onError = () => {
    setLoadError(local?.isFile
      ? "Your browser can't play this file. MP4 files work best; some MKV files have sound or video the browser can't decode. Screen share still works for those."
      : "That link didn't load. It must point straight at a video file or stream, not a web page.");
  };

  // If MY player stalls for more than 1.5s, pause everyone until I've caught up.
  const onWaiting = () => {
    clearTimeout(waitingTimer.current);
    waitingTimer.current = setTimeout(() => {
      const v = videoRef.current;
      if (syncRef.current?.playing && v && v.readyState < 3) {
        iPausedForBuffering.current = true;
        socket.emit("sync-action", { action: "pause", position: v.currentTime, reason: "buffering" });
      }
    }, 1500);
  };
  const onCanPlay = () => {
    clearTimeout(waitingTimer.current);
    const s = syncRef.current;
    if (iPausedForBuffering.current && s && !s.playing && s.reason === "buffering" && s.byId === clientId) {
      iPausedForBuffering.current = false;
      socket.emit("sync-action", { action: "play", position: videoRef.current.currentTime });
    }
  };

  // ---------- My controls (these are the only things that send to the room) ----------
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v || !source) return;
    const playing = syncRef.current.playing;
    socket.emit("sync-action", { action: playing ? "pause" : "play", position: v.currentTime });
    // Respond instantly here; the room confirms a moment later.
    if (playing) v.pause();
    else v.play().catch(() => setNeedsTap(true));
  };
  const seekTo = (t) => {
    const v = videoRef.current;
    if (!v) return;
    const pos = Math.max(0, Math.min(t, (v.duration || t) - 0.5));
    v.currentTime = pos;
    socket.emit("sync-action", { action: "seek", position: pos });
  };

  const onKey = (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.code === "Space" || e.key === "k") { e.preventDefault(); togglePlay(); }
    if (e.key === "ArrowRight") { e.preventDefault(); seekTo((videoRef.current?.currentTime || 0) + 10); }
    if (e.key === "ArrowLeft") { e.preventDefault(); seekTo((videoRef.current?.currentTime || 0) - 10); }
    if (e.key === "f") fullscreen();
  };

  const fullscreen = () => {
    const el = boxRef.current;
    if (document.fullscreenElement) document.exitFullscreen();
    else if (el?.requestFullscreen) el.requestFullscreen();
    else videoRef.current?.webkitEnterFullscreen?.();
  };

  const loadSubs = async (file) => {
    if (!file) return;
    const text = await file.text();
    const vtt = file.name.toLowerCase().endsWith(".srt") ? srtToVtt(text) : text;
    setSubsUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
    });
    flash("Subtitles on (only for you).");
  };
  // Make sure the subtitle track is actually showing once it's attached.
  useEffect(() => {
    const tracks = videoRef.current?.textTracks;
    if (tracks?.length) tracks[0].mode = subsUrl ? "showing" : "disabled";
  }, [subsUrl]);

  // Movie volume, with "ducking" while someone else talks (same as screen share).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const target = volume * (duck ? 0.3 : 1);
    let raf;
    const step = () => {
      const d = target - v.volume;
      if (Math.abs(d) < 0.02) { v.volume = target; return; }
      v.volume = Math.min(1, Math.max(0, v.volume + d * (duck ? 0.25 : 0.08)));
      raf = requestAnimationFrame(step);
    };
    step();
    return () => cancelAnimationFrame(raf);
  }, [volume, duck, local]);

  // Duration mismatch = probably a different cut or a different file.
  const mismatch = source?.duration && duration && Math.abs(source.duration - duration) > 5;
  const sourceOwner = members.find((m) => m.id === source?.byId)?.name || source?.by;
  const waitingName = sync?.reason === "buffering" ? (members.find((m) => m.id === sync.byId)?.name || sync.by) : null;
  const shown = scrub ?? current;

  return (
    <div className="stage sync-stage" ref={boxRef} tabIndex={0} onKeyDown={onKey}>
      <video
        ref={videoRef}
        className={local ? "on" : ""}
        playsInline
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onWaiting={onWaiting}
        onCanPlay={onCanPlay}
        onPlaying={onCanPlay}
        onError={onError}
        onClick={togglePlay}
      >
        {subsUrl && <track kind="subtitles" src={subsUrl} srcLang="en" label="Subtitles" default />}
      </video>

      {!local && (
        <div className="stage-empty sync-pick">
          <div className="curtain" aria-hidden="true" />
          <span className="eyebrow">Movie sync · full quality for everyone</span>
          <h2>{source ? `The room is watching “${source.name}”` : "Pick tonight's movie"}</h2>
          <p>
            {source
              ? `Load your own copy and you'll jump straight to where ${sourceOwner || "they"} are${source.duration ? ` (${fmt(source.duration)} long)` : ""}.`
              : "Everyone plays their own copy, so it's full HD no matter how slow the internet is. Matinée just keeps you together."}
          </p>
          <div className="pick-options">
            <label className="btn btn-primary">
              Choose a video file
              <input type="file" accept="video/*,.mkv,.mp4,.webm,.mov,.m4v" hidden onChange={(e) => loadFile(e.target.files?.[0])} />
            </label>
            <form className="link-form" onSubmit={(e) => { e.preventDefault(); loadLink(linkDraft); }}>
              <input value={linkDraft} onChange={(e) => setLinkDraft(e.target.value)} placeholder="…or paste a direct video link" />
              <button className="btn btn-ghost" type="submit">Load</button>
            </form>
            {source?.url && (
              isLocalLink(source.url) ? (
                <p className="hint">{sourceOwner}'s link only works on their computer (it comes from their own Stremio app). Paste the link from <b>your</b> Stremio instead.</p>
              ) : (
                <button className="btn btn-ghost" onClick={() => loadLink(source.url)}>Use {sourceOwner}'s link</button>
              )
            )}
          </div>
          {loadError && <p className="error-text">{loadError}</p>}
        </div>
      )}

      {local && (
        <>
          <div className="stage-overlay">
            <span className={`sync-pill ${status}`}>
              {status === "waiting" ? `Waiting for ${waitingName || "someone"}…`
                : status === "synced" ? "● In sync"
                : status === "syncing" ? "Catching up…"
                : status === "paused" ? "Paused" : "Loading…"}
            </span>
            {mismatch && <span className="warn-pill" title="Your copy's length is different from the room's movie">Different length: {fmt(duration)} vs {fmt(source.duration)}</span>}
            <div className="stage-tools">
              <label className="icon-btn" title="Add subtitles (.srt or .vtt) — just for you">
                CC
                <input type="file" accept=".srt,.vtt" hidden onChange={(e) => loadSubs(e.target.files?.[0])} />
              </label>
              <button className="icon-btn" onClick={fullscreen} aria-label="Fullscreen">⛶</button>
            </div>
          </div>

          <div className="player-bar">
            <button className="play-btn" onClick={togglePlay} aria-label={sync?.playing ? "Pause for everyone" : "Play for everyone"}>
              {sync?.playing ? "❚❚" : "▶"}
            </button>
            <span className="time">{fmt(shown)}</span>
            <input
              className="seek" type="range" min="0" max={duration || 0} step="0.1" value={Math.min(shown, duration || 0)}
              onChange={(e) => setScrub(Number(e.target.value))}
              onPointerUp={(e) => { seekTo(Number(e.currentTarget.value)); setScrub(null); }}
              onKeyUp={(e) => { seekTo(Number(e.currentTarget.value)); setScrub(null); }}
              aria-label="Seek for everyone"
              style={{ "--pct": `${duration ? (Math.min(shown, duration) / duration) * 100 : 0}%` }}
            />
            <span className="time">{fmt(duration)}</span>
            <input className="volume" type="range" min="0" max="1" step="0.05" value={volume}
              onChange={(e) => setVolume(Number(e.target.value))} aria-label="Volume (just for you)" />
          </div>

          {loadError && <p className="sync-error">{loadError}</p>}
        </>
      )}

      {needsTap && local && sync?.playing && (
        <button className="tap-to-watch" onClick={() => videoRef.current?.play().then(() => setNeedsTap(false))}>
          <span>▶</span> Tap to join the movie
        </button>
      )}

      <div className="floaters" aria-hidden="true">
        {floaters.map((f) => (
          <span key={f.id} className="floater" style={{ left: `${f.left}%` }}>{f.emoji}</span>
        ))}
      </div>
    </div>
  );
}

// Used after a server restart: what we last knew, so the room can be put back.
export function syncSnapshot(sync) {
  if (!sync?.source) return null;
  return { source: sync.source, playing: sync.playing, position: expectedPosition(sync) };
}