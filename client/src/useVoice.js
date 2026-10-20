import { useCallback, useEffect, useRef, useState } from "react";
import { socket, clientId } from "./socket.js";
import { iceServers } from "./ice.js";


const SPEAK_THRESHOLD = 0.012; // loudness (RMS) above which we call it "speaking"
const HOLD_MS = 450; // keep the "speaking" glow briefly so it doesn't flicker between words

const isInitiator = (otherId) => clientId < otherId;

export function useVoice({ selfId, members }) {
  const [micOn, setMicOn] = useState(false);
  const [micError, setMicError] = useState("");
  const [speaking, setSpeaking] = useState({}); // { [clientId]: true }
  const [needsUnlock, setNeedsUnlock] = useState(false);

  const peers = useRef(new Map()); // otherId -> { pc, audio, pending: [], retry }
  const micRef = useRef(null); // our microphone track (kept after first use, muted via .enabled)
  const micOnRef = useRef(false);
  const chain = useRef(Promise.resolve()); // handle voice events one at a time, in order
  const ctxRef = useRef(null); // AudioContext used only for measuring loudness
  const meters = useRef(new Map()); // id -> { src, an, buf, lastLoud }

  const run = (fn) => {
    chain.current = chain.current.then(fn).catch((e) => console.warn("voice error", e));
    return chain.current;
  };

  // ---------- Loudness meters ----------
  const getCtx = () => {
    if (!ctxRef.current) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctxRef.current = new AC();
    }
    return ctxRef.current;
  };

  const removeMeter = (id) => {
    const m = meters.current.get(id);
    if (!m) return;
    try { m.src.disconnect(); } catch { /* already gone */ }
    meters.current.delete(id);
  };

  const addMeter = (id, stream) => {
    const ctx = getCtx();
    if (!ctx) return;
    removeMeter(id);
    try {
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an); // measured only, never sent to the speakers (the <audio> element plays it)
      meters.current.set(id, { src, an, buf: new Float32Array(an.fftSize), lastLoud: 0 });
    } catch { /* metering is a nice-to-have */ }
  };

  // Browsers keep sound off until the person clicks something on the page.
  const unlock = useCallback(() => {
    ctxRef.current?.resume?.().catch(() => {});
    let blocked = false;
    peers.current.forEach(({ audio }) => {
      audio?.play().catch(() => { blocked = true; });
    });
    setNeedsUnlock(blocked);
  }, []);

  // ---------- Connections ----------
  const sendSignal = (to, data) => socket.emit("voice-signal", { to, data });

  const voiceTransceiver = (pc) => pc.getTransceivers().find((t) => t.receiver.track?.kind === "audio");

  const closePeer = (id) => {
    const p = peers.current.get(id);
    if (!p) return;
    clearTimeout(p.retry);
    p.pc.close();
    if (p.audio) {
      p.audio.pause();
      p.audio.srcObject = null;
    }
    removeMeter(id);
    peers.current.delete(id);
  };

  const createPeer = (id) => {
    closePeer(id);
    const pc = new RTCPeerConnection({ iceServers });
    const entry = { pc, audio: null, pending: [], retry: null };
    peers.current.set(id, entry);

    pc.onicecandidate = (e) => {
      if (e.candidate) sendSignal(id, { type: "candidate", candidate: e.candidate });
    };

    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      const audio = new Audio();
      audio.autoplay = true;
      audio.srcObject = stream; // playing it through an <audio> element also lets echo cancellation see it
      entry.audio = audio;
      audio.play().catch(() => setNeedsUnlock(true));
      addMeter(id, stream);
    };

    pc.onconnectionstatechange = () => {
      if (peers.current.get(id) !== entry) return; // an older, replaced line
      const s = pc.connectionState;
      if (s === "connected") clearTimeout(entry.retry);
      if (s === "failed" || s === "disconnected") {
        clearTimeout(entry.retry);
        // "disconnected" often heals itself; "failed" won't. Re-dial if it doesn't recover.
        entry.retry = setTimeout(() => {
          if (peers.current.get(id) === entry && pc.connectionState !== "connected") redial(id);
        }, s === "failed" ? 1000 : 6000);
      }
    };
    return entry;
  };

  const startCall = async (id) => {
    const { pc } = createPeer(id);
    const t = pc.addTransceiver("audio", { direction: "sendrecv" });
    if (micRef.current) await t.sender.replaceTrack(micRef.current);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal(id, { type: "offer", sdp: pc.localDescription });
  };

  // Rebuild the line to one person: dial if it's our job, otherwise ask them to.
  const redial = (id) => {
    if (isInitiator(id)) run(() => startCall(id));
    else sendSignal(id, { type: "request" });
  };

  const flushCandidates = async (entry) => {
    for (const c of entry.pending.splice(0)) await entry.pc.addIceCandidate(c).catch(() => {});
  };

  const handleSignal = async ({ from, data }) => {
    if (data.type === "request") {
      if (isInitiator(from)) await startCall(from);
      return;
    }
    if (data.type === "offer") {
      const entry = createPeer(from);
      const { pc } = entry;
      await pc.setRemoteDescription(data.sdp);
      const t = voiceTransceiver(pc);
      if (t) {
        t.direction = "sendrecv"; // so we can talk back later without re-negotiating
        if (micRef.current) await t.sender.replaceTrack(micRef.current);
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal(from, { type: "answer", sdp: pc.localDescription });
      await flushCandidates(entry);
      return;
    }
    const entry = peers.current.get(from);
    if (!entry) return;
    if (data.type === "answer") {
      if (entry.pc.signalingState !== "have-local-offer") return;
      await entry.pc.setRemoteDescription(data.sdp);
      await flushCandidates(entry);
    } else if (data.type === "candidate") {
      // Candidates can arrive before the description they belong to: hold them until then.
      if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(data.candidate).catch(() => {});
      else entry.pending.push(data.candidate);
    }
  };

  useEffect(() => {
    const onSignal = (msg) => run(() => handleSignal(msg));
    socket.on("voice-signal", onSignal);
    return () => socket.off("voice-signal", onSignal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Make sure there's a line to everyone currently in the room (and none to people who left).
  useEffect(() => {
    if (!selfId) return;
    const others = members.filter((m) => m.id !== clientId);
    const ids = new Set(others.map((m) => m.id));
    for (const id of [...peers.current.keys()]) if (!ids.has(id)) closePeer(id);

    const timers = [];
    for (const m of others) {
      if (m.online === false || peers.current.has(m.id)) continue;
      if (isInitiator(m.id)) {
        run(() => (peers.current.has(m.id) ? null : startCall(m.id)));
      } else {
        // Give the other side a moment to call us; if they don't (e.g. they have a stale line
        // from before we refreshed), ask them to.
        timers.push(setTimeout(() => {
          if (!peers.current.has(m.id)) sendSignal(m.id, { type: "request" });
        }, 1500));
      }
    }
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, selfId]);

  // ---------- Microphone ----------
  const setMicState = (on) => {
    micOnRef.current = on;
    setMicOn(on);
    socket.emit("voice-state", { mic: on });
  };

  const toggleMic = useCallback(async () => {
    setMicError("");
    const track = micRef.current;
    if (track && track.readyState === "live") {
      track.enabled = !micOnRef.current; // mute/unmute without releasing the mic
      setMicState(!micOnRef.current);
      unlock();
      return { firstTime: false };
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicError("This browser can't use a microphone here. Voice needs a secure (https) link.");
      return null;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const mic = stream.getAudioTracks()[0];
      mic.contentHint = "speech";
      mic.addEventListener("ended", () => {
        micRef.current = null;
        removeMeter(clientId);
        setMicState(false);
      });
      micRef.current = mic;
      // Plug the mic into every existing line. No re-dialing needed.
      await Promise.all([...peers.current.values()].map(({ pc }) =>
        voiceTransceiver(pc)?.sender.replaceTrack(mic).catch(() => {})));
      addMeter(clientId, new MediaStream([mic]));
      unlock();
      setMicState(true);
      return { firstTime: true };
    } catch (e) {
      setMicError(e?.name === "NotAllowedError"
        ? "Microphone is blocked. Allow it from the icon in the address bar, then try again."
        : "Couldn't open your microphone. Is another app using it?");
      return null;
    }
  }, [unlock]);

  // ---------- Speaking detection ----------
  useEffect(() => {
    const timer = setInterval(() => {
      const now = performance.now();
      const next = {};
      meters.current.forEach((m, id) => {
        if (id === clientId && !micOnRef.current) return; // muted: never "speaking"
        m.an.getFloatTimeDomainData(m.buf);
        let sum = 0;
        for (let i = 0; i < m.buf.length; i++) sum += m.buf[i] * m.buf[i];
        if (Math.sqrt(sum / m.buf.length) > SPEAK_THRESHOLD) m.lastLoud = now;
        if (now - m.lastLoud < HOLD_MS) next[id] = true;
      });
      setSpeaking((prev) => {
        const a = Object.keys(prev);
        const b = Object.keys(next);
        return a.length === b.length && b.every((k) => prev[k]) ? prev : next;
      });
    }, 120);
    return () => clearInterval(timer);
  }, []);

  // Any click anywhere on the page counts as permission to play sound.
  useEffect(() => {
    const onFirstGesture = () => unlock();
    window.addEventListener("pointerdown", onFirstGesture);
    window.addEventListener("keydown", onFirstGesture);
    return () => {
      window.removeEventListener("pointerdown", onFirstGesture);
      window.removeEventListener("keydown", onFirstGesture);
    };
  }, [unlock]);

  // Hang up everything when leaving the room.
  useEffect(() => () => {
    [...peers.current.keys()].forEach(closePeer);
    micRef.current?.stop();
    ctxRef.current?.close().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const othersSpeaking = Object.keys(speaking).some((id) => id !== clientId);

  return {
    micOn, micError, toggleMic, speaking, othersSpeaking, needsUnlock, unlock,
    getMicOn: () => micOnRef.current,
  };
}