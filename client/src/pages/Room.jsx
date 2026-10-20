import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { socket, clientId } from "../socket.js";
import { useScreenShare, QUALITY } from "../useScreenShare.js";
import { useVoice } from "../useVoice.js";
import SyncStage, { syncSnapshot } from "../SyncStage.jsx";
import { rememberRoom } from "../catalog.js";

const EMOJIS = ["😂", "😱", "😭", "❤️", "🔥", "🍿"];
const canShare = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;

export default function Room() {
  const { roomId } = useParams();
  const [name, setName] = useState(() => localStorage.getItem("matinee-name") || "");
  const [nameDraft, setNameDraft] = useState("");
  const [joined, setJoined] = useState(false);
  const [selfId, setSelfId] = useState(null);
  const [members, setMembers] = useState([]);
  const [sharerId, setSharerId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [floaters, setFloaters] = useState([]);
  const [toast, setToast] = useState("");
  const [chatOpen, setChatOpen] = useState(true);
  const [unread, setUnread] = useState(0);
  const [joinError, setJoinError] = useState("");
  const [offline, setOffline] = useState(false); // our own connection to the server dropped
  const [mode, setMode] = useState("share"); // "share" = screen share, "sync" = movie sync
  const [sync, setSync] = useState(null);
  const [pick, setPick] = useState(null); // "tonight's pick" if the room was opened from a movie
  const lastSync = useRef(null); // last known movie-sync state, to restore after a server restart

  const { isSharer, localStream, remoteStream, connState, hasAudio, quality, setQuality, stats, startShare, stopShare, reconnect, reconcile } =
    useScreenShare({ selfId, sharerId });
  const reconcileRef = useRef(reconcile);
  reconcileRef.current = reconcile;

  const voice = useVoice({ selfId, members });
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  // ----- Join the room once we have a name -----
  useEffect(() => {
    if (!name) return;
    socket.connect();
    const join = () =>
      // Runs on the first connect AND after every reconnect, with the same clientId,
      // so the server knows it's the same person and nothing gets reset.
      socket.emit("join-room", { roomId, name, clientId, mic: voiceRef.current.getMicOn() }, (res) => {
        if (res?.error) return setJoinError(res.error);
        setOffline(false);
        setSelfId(res.self);
        setMembers(res.state.members);
        setSharerId(res.state.sharerId);
        setMode(res.state.mode);
        setSync(res.state.sync);
        setPick(res.state.pick || null);
        rememberRoom(roomId, res.state.pick);
        setJoined(true);
        reconcileRef.current(res.state.sharerId);
        // Server forgot the movie (it restarted) but we still know it: put it back.
        if (!res.state.sync?.source && lastSync.current?.source) {
          socket.emit("sync-restore", syncSnapshot(lastSync.current));
        }
      });
    socket.on("connect", join);
    if (socket.connected) join();
    const onDisconnect = () => setOffline(true);
    const onReplaced = () => setJoinError("This room is open in another tab, so this one was paused.");
    socket.on("disconnect", onDisconnect);
    socket.on("replaced", onReplaced);

    const onState = (s) => {
      setMembers(s.members);
      setSharerId(s.sharerId);
      setMode(s.mode);
      setSync(s.sync);
      setPick(s.pick || null);
    };
    // A small heads-up when someone else controls the movie.
    const onSyncEvent = (e) => {
      if (e.byId === clientId) return;
      const at = Number.isFinite(e.position) ? ` at ${fmtTime(e.position)}` : "";
      const text = {
        play: `${e.by} pressed play${at}`,
        pause: e.reason === "buffering" ? `Waiting for ${e.by} to catch up…` : `${e.by} paused${at}`,
        seek: `${e.by} jumped to ${fmtTime(e.position)}`,
        source: `${e.by} picked “${e.name}”. Load your copy to watch.`,
        cleared: `${e.by} is choosing a new movie`,
      }[e.action];
      if (text) flashRef.current(text);
    };
    socket.on("sync-event", onSyncEvent);
    const onChat = (m) => setMessages((prev) => [...prev.slice(-199), { kind: "chat", ...m }]);
    const onSystem = (m) => setMessages((prev) => [...prev.slice(-199), { kind: "system", id: `${Date.now()}${Math.random()}`, ...m }]);
    const onReaction = ({ emoji }) => {
      const id = `${Date.now()}${Math.random()}`;
      setFloaters((f) => [...f, { id, emoji, left: 10 + Math.random() * 80 }]);
      setTimeout(() => setFloaters((f) => f.filter((x) => x.id !== id)), 2600);
    };

    socket.on("room-state", onState);
    socket.on("chat", onChat);
    socket.on("system", onSystem);
    socket.on("reaction", onReaction);
    return () => {
      socket.off("connect", join);
      socket.off("disconnect", onDisconnect);
      socket.off("replaced", onReplaced);
      socket.off("room-state", onState);
      socket.off("sync-event", onSyncEvent);
      socket.off("chat", onChat);
      socket.off("system", onSystem);
      socket.off("reaction", onReaction);
      socket.disconnect();
    };
  }, [name, roomId]);

  // Count unread messages while the chat is closed.
  const lastCount = useRef(0);
  useEffect(() => {
    const newOnes = messages.length - lastCount.current;
    lastCount.current = messages.length;
    if (!chatOpen && newOnes > 0) setUnread((u) => u + newOnes);
  }, [messages, chatOpen]);

  // The hide-timer lives in a ref so a newer notice cancels the older notice's timer
  // (otherwise the old timer could wipe out the new notice early).
  const toastTimer = useRef(null);
  const flash = (t) => {
    setToast(t);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2800);
  };
  const flashRef = useRef(flash);
  flashRef.current = flash;

  // Remember the latest movie-sync state (used to restore it after a server restart).
  useEffect(() => {
    if (sync?.source) lastSync.current = sync;
    else if (sync) lastSync.current = null;
  }, [sync]);

  // Screen sharing and movie sync don't run together: switching to sync ends my share.
  useEffect(() => {
    if (mode === "sync" && localStream) stopShare();
  }, [mode, localStream, stopShare]);

  const switchMode = (m) => socket.emit("set-mode", { mode: m });

  const copyLink = async () => {
    const link = window.location.href;
    try {
      if (navigator.share && /Mobi/i.test(navigator.userAgent)) {
        await navigator.share({ title: "Watch with me on Matinée", url: link });
      } else {
        await navigator.clipboard.writeText(link);
        flash("Invite link copied. Send it over!");
      }
    } catch {
      /* user cancelled share sheet */
    }
  };

  const onShare = async () => {
    try {
      const { hasAudio } = await startShare();
      if (!hasAudio) flash("No sound captured. Stop, then share a Chrome tab with “Share tab audio” on.");
    } catch (e) {
      if (e?.name !== "NotAllowedError") flash(e.message || "Couldn't start sharing.");
    }
  };

  const onMic = async () => {
    const res = await voice.toggleMic();
    if (res?.firstTime) flash("Mic on. Tip: wear headphones so the movie doesn't echo back to them.");
  };
  useEffect(() => {
    if (voice.micError) flash(voice.micError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.micError]);

  const sendChat = (e) => {
    e.preventDefault();
    if (!draft.trim()) return;
    socket.emit("chat", { text: draft });
    setDraft("");
  };

  // ----- Name gate -----
  if (!name) {
    return (
      <div className="gate">
        <form
          className="gate-card"
          onSubmit={(e) => {
            e.preventDefault();
            const n = nameDraft.trim();
            if (!n) return;
            localStorage.setItem("matinee-name", n);
            setName(n);
          }}
        >
          <span className="logo">Matinée<span className="logo-dot">●</span></span>
          <h2>You're invited to a screening</h2>
          <p>Room <code>{roomId}</code>. What should we call you?</p>
          <input autoFocus value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} placeholder="Your name" maxLength={24} />
          <button className="btn btn-primary btn-lg" type="submit">Take my seat</button>
        </form>
      </div>
    );
  }

  if (joinError) {
    return (
      <div className="gate">
        <div className="gate-card">
          <h2>Can't get in</h2>
          <p>{joinError}</p>
          <Link className="btn btn-ghost" to="/">Back home</Link>
        </div>
      </div>
    );
  }

  const sharer = members.find((m) => m.id === sharerId);
  const someoneElseSharing = sharerId && !isSharer;

  return (
    <div className={`room ${chatOpen ? "" : "chat-closed"}`}>
      <header className="room-top">
        <Link to="/" className="logo small">Matinée<span className="logo-dot">●</span></Link>
        <div className="room-code" title="Room code">
          <span className="label">Room</span> {roomId}
        </div>
        {pick && (
          <span className="pick-chip" title={`Tonight's pick: ${pick.title}`}>
            {pick.poster && <img src={pick.poster} alt="" />}
            <span>Tonight</span> <b>{pick.title}</b>
          </span>
        )}
        {offline && <span className="reconnecting">Reconnecting…</span>}
        {voice.needsUnlock && (
          <button className="btn btn-ghost btn-sm unlock" onClick={voice.unlock}>🔊 Tap to hear voices</button>
        )}
        <div className="avatars">
          {members.map((m) => (
            <span key={m.id}
              className={`avatar ${m.online === false ? "away" : ""} ${voice.speaking[m.id] ? "speaking" : ""}`}
              style={{ "--c": m.color }}
              title={`${m.name}${m.id === selfId ? " (you)" : ""}${m.online === false ? " · reconnecting…" : ""}${m.mic ? " · mic on" : " · muted"}`}>
              {m.name[0]?.toUpperCase()}
              {m.id === sharerId && <i className="avatar-live" />}
              {m.mic && <i className="avatar-mic" aria-hidden="true">🎙</i>}
            </span>
          ))}
        </div>
        <button className="btn btn-primary btn-sm" onClick={copyLink}>Invite</button>
        <button className="btn btn-ghost btn-sm chat-toggle" onClick={() => { setChatOpen((o) => !o); setUnread(0); }}>
          Chat{unread > 0 && !chatOpen && <span className="badge">{unread}</span>}
        </button>
      </header>

      <main className="stage-wrap">
        {mode === "sync" ? (
          <SyncStage sync={sync} duck={voice.othersSpeaking} floaters={floaters} flash={flash} members={members} pick={pick} />
        ) : (
        <Stage
          isSharer={isSharer}
          localStream={localStream}
          remoteStream={remoteStream}
          connState={connState}
          sharerName={sharer?.name}
          someoneElseSharing={someoneElseSharing}
          hasAudio={hasAudio}
          onShare={onShare}
          onReconnect={reconnect}
          floaters={floaters}
          stats={stats}
          joined={joined}
          alone={members.length <= 1}
          onInvite={copyLink}
          duck={voice.othersSpeaking}
        />
        )}

        <div className="controls">
          <button className={`btn mic-btn ${voice.micOn ? "on" : ""}`} onClick={onMic}
            aria-pressed={voice.micOn} title={voice.micOn ? "Mute your mic" : "Talk to the room"}>
            <MicIcon off={!voice.micOn} />
            {voice.micOn ? (voice.speaking[selfId] ? "Talking…" : "Mic on") : "Mic off"}
          </button>
          <div className="mode-switch" role="radiogroup" aria-label="How to watch">
            <button role="radio" aria-checked={mode === "share"} className={mode === "share" ? "active" : ""}
              onClick={() => switchMode("share")} title="Share any tab: YouTube, websites, anything">Screen share</button>
            <button role="radio" aria-checked={mode === "sync"} className={mode === "sync" ? "active" : ""}
              onClick={() => switchMode("sync")} title="Everyone plays their own copy in full quality">Movie sync</button>
          </div>
          {mode === "sync" ? (
            sync?.source && (
              <button className="btn btn-ghost" onClick={() => socket.emit("sync-source", null)}
                title="Clear the current movie so someone can pick another">New movie</button>
            )
          ) : isSharer ? (
            <>
              <button className="btn btn-danger" onClick={stopShare}>■ Stop sharing</button>
              <div className="quality" role="radiogroup" aria-label="Stream quality">
                {Object.entries(QUALITY).map(([key, q]) => (
                  <button key={key} role="radio" aria-checked={quality === key}
                    className={quality === key ? "active" : ""} onClick={() => setQuality(key)}>
                    {q.label}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <button className="btn btn-primary" onClick={onShare} disabled={!!someoneElseSharing || !canShare}
              title={!canShare ? "Sharing needs Chrome or Edge on a computer" : undefined}>
              ▶ Share a tab
            </button>
          )}
          <div className="reactions">
            {EMOJIS.map((e) => (
              <button key={e} className="emoji-btn" onClick={() => socket.emit("reaction", { emoji: e })} aria-label={`React ${e}`}>
                {e}
              </button>
            ))}
          </div>
        </div>
      </main>

      <aside className="chat" aria-hidden={!chatOpen}>
        <div className="chat-head">
          <h3>Lobby chat</h3>
          <span>{members.length} here</span>
        </div>
        <ChatList messages={messages} selfId={selfId} />
        <form className="chat-form" onSubmit={sendChat}>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Say something…" maxLength={500} />
          <button className="btn btn-primary btn-sm" type="submit">Send</button>
        </form>
      </aside>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function fmtTime(t) {
  t = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function MicIcon({ off }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
      {off && <path d="M3 3l18 18" />}
    </svg>
  );
}

function StatsPill({ stats, isSharer }) {
  if (!stats || !stats.width) return null;
  const h = stats.height;
  const p = h >= 1000 ? "1080p" : h >= 700 ? "720p" : h >= 530 ? "540p" : h >= 470 ? "480p" : h >= 350 ? "360p" : `${h}p`;
  const reason = { cpu: "computer is busy", bandwidth: "connection is slow" }[stats.limitedBy];
  return (
    <span className="stats-pill" title={`${stats.width}×${stats.height} · ${stats.codec}${stats.rttMs != null ? ` · ${stats.rttMs} ms delay` : ""}`}>
      {isSharer ? "Sending " : ""}{isSharer && stats.auto ? "Auto " : ""}{p} · {stats.fps} fps · {stats.mbps.toFixed(1)} Mbps
      {isSharer && stats.uploadMbps != null && <> · upload ≈ {stats.uploadMbps.toFixed(1)} Mbps</>}
      {isSharer && reason && <em> · lowered: {reason}</em>}
    </span>
  );
}

function Stage({ isSharer, localStream, remoteStream, connState, sharerName, someoneElseSharing, hasAudio,
  onShare, onReconnect, floaters, stats, joined, alone, onInvite, duck }) {
  const videoRef = useRef(null);
  const boxRef = useRef(null);
  const [needsTap, setNeedsTap] = useState(false);
  const [volume, setVolume] = useState(1);

  const stream = isSharer ? localStream : remoteStream;

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = stream || null;
    if (!stream) return;
    // The sharer's preview is muted so they don't hear the movie twice.
    v.muted = isSharer;
    v.play().then(() => setNeedsTap(false)).catch(() => setNeedsTap(true)); // browsers block sound until a tap
  }, [stream, isSharer]);

  // Movie volume. While someone else talks, gently dip the movie ("ducking") so you can hear them,
  // then bring it back. The fade avoids an abrupt jump.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const target = volume * (duck ? 0.3 : 1);
    let raf;
    const step = () => {
      const diff = target - v.volume;
      if (Math.abs(diff) < 0.02) {
        v.volume = target;
        return;
      }
      v.volume = Math.min(1, Math.max(0, v.volume + diff * (duck ? 0.25 : 0.08))); // dip fast, recover slowly
      raf = requestAnimationFrame(step);
    };
    step();
    return () => cancelAnimationFrame(raf);
  }, [volume, duck]);

  const fullscreen = () => {
    const el = boxRef.current;
    if (document.fullscreenElement) document.exitFullscreen();
    else if (el?.requestFullscreen) el.requestFullscreen();
    else videoRef.current?.webkitEnterFullscreen?.(); // iPhone
  };

  return (
    <div className="stage" ref={boxRef}>
      <video ref={videoRef} playsInline className={stream ? "on" : ""} />

      {!stream && (
        <div className="stage-empty">
          {someoneElseSharing ? (
            <>
              <div className="spinner" />
              <h2>Connecting to {sharerName}'s screen…</h2>
              {connState === "failed" && (
                <>
                  <p>The connection didn't go through. This can happen on strict networks.</p>
                  <button className="btn btn-ghost" onClick={onReconnect}>Try again</button>
                </>
              )}
            </>
          ) : (
            <>
              <div className="curtain" aria-hidden="true" />
              <h2>{!joined ? "Finding your seat…" : alone ? "The house is empty. For now." : "The screen is dark"}</h2>
              <p>
                {alone
                  ? "Send the invite link to your person. When they arrive, one of you shares a movie tab."
                  : "Open your movie in a Chrome tab (Stremio Web works great), then share it here."}
              </p>
              <div className="stage-actions">
                {alone && <button className="btn btn-ghost" onClick={onInvite}>Copy invite link</button>}
                {canShare ? (
                  <button className="btn btn-primary" onClick={onShare}>▶ Share a tab</button>
                ) : (
                  <p className="hint">You can watch from this device. Sharing needs Chrome or Edge on a computer.</p>
                )}
              </div>
              {canShare && (
                <ol className="tips">
                  <li>Pick the <b>Chrome Tab</b> option, not “Entire screen”.</li>
                  <li>Choose your movie tab.</li>
                  <li>Make sure <b>Share tab audio</b> is switched on.</li>
                </ol>
              )}
            </>
          )}
        </div>
      )}

      {stream && (
        <div className="stage-overlay">
          <span className="live-pill">● {isSharer ? "You're sharing" : `Live from ${sharerName ?? "host"}`}</span>
          {isSharer && !hasAudio && <span className="warn-pill">No sound captured</span>}
          <StatsPill stats={stats} isSharer={isSharer} />
          <div className="stage-tools">
            {!isSharer && (
              <input className="volume" type="range" min="0" max="1" step="0.05" value={volume}
                onChange={(e) => setVolume(Number(e.target.value))} aria-label="Volume" />
            )}
            <button className="icon-btn" onClick={fullscreen} aria-label="Fullscreen">⛶</button>
          </div>
        </div>
      )}

      {needsTap && stream && !isSharer && (
        <button className="tap-to-watch" onClick={() => videoRef.current?.play().then(() => setNeedsTap(false))}>
          <span>▶</span> Tap to watch with sound
        </button>
      )}

      {isSharer && stream && (
        <p className="sharer-note">Keep watching in your movie tab. This is just a preview of what they see.</p>
      )}

      <div className="floaters" aria-hidden="true">
        {floaters.map((f) => (
          <span key={f.id} className="floater" style={{ left: `${f.left}%` }}>{f.emoji}</span>
        ))}
      </div>
    </div>
  );
}

function ChatList({ messages, selfId }) {
  const endRef = useRef(null);
  // Braces matter: an effect may only return a cleanup function. Newer Chrome makes
  // scrollIntoView return a Promise, which React would later try to call and crash.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);
  return (
    <div className="chat-list">
      {messages.length === 0 && <p className="chat-empty">No messages yet. Say hi 👋</p>}
      {messages.map((m) =>
        m.kind === "system" ? (
          <p key={m.id} className="msg-system">{m.text}</p>
        ) : (
          <div key={m.id} className={`msg ${m.from === selfId ? "mine" : ""}`}>
            <span className="msg-name" style={{ color: m.color }}>{m.from === selfId ? "You" : m.name}</span>
            <p>{m.text}</p>
          </div>
        )
      )}
      <div ref={endRef} />
    </div>
  );
}
