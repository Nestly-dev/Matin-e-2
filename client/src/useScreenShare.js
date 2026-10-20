import { useCallback, useEffect, useRef, useState } from "react";
import { socket, clientId } from "./socket.js";
import { iceServers } from "./ice.js";


export const QUALITY = {
  // Default. Measures the upload speed every 2s and picks the resolution that fits it (see AUTO_LADDER).
  auto: { label: "Auto", maxBitrate: 6_000_000, maxFramerate: 30, degradation: "balanced", scaleDown: 1, adaptive: true },
  // Always full resolution. Only looks good with a fast upload (~4+ Mbps); on a slow one it gets choppy.
  hd: { label: "Sharp", maxBitrate: 8_000_000, maxFramerate: 30, degradation: "maintain-resolution", scaleDown: 1 },
  saver: { label: "Data saver", maxBitrate: 900_000, maxFramerate: 24, degradation: "maintain-framerate", targetHeight: 480 },
};

/**
 * Auto mode's "ladder": the picture height to aim for at a given upload speed.
 * Roughly what a movie needs to look clean at 30 fps with H.264. Lower resolution at full
 * frame rate looks much better than full resolution as a slideshow.
 */
const AUTO_LADDER = [
  { minMbps: 4.5, height: 1080 },
  { minMbps: 2.2, height: 720 },
  { minMbps: 1.0, height: 540 },
  { minMbps: 0, height: 360 },
];

// Which ladder step fits this speed? Stepping UP needs 25% headroom so it doesn't flip back and forth.
function pickStep(mbps, currentStep) {
  let step = AUTO_LADDER.findIndex((s) => mbps >= s.minMbps);
  if (step < currentStep && mbps < AUTO_LADDER[step].minMbps * 1.25) step = currentStep;
  return step;
}

// Video codec order. H.264 first because Macs and most laptops encode it in hardware,
// so it stays sharp without maxing out the CPU. VP9 next (better quality per bit, but software).
const CODEC_ORDER = ["video/H264", "video/VP9", "video/VP8", "video/AV1"];

function preferCodecs(pc) {
  try {
    const caps = RTCRtpReceiver.getCapabilities?.("video");
    if (!caps) return;
    const rank = (c) => {
      const i = CODEC_ORDER.indexOf(c.mimeType);
      return i === -1 ? 99 : i; // rtx / red / fec keep their place at the end
    };
    const sorted = [...caps.codecs].sort((a, b) => rank(a) - rank(b));
    pc.getTransceivers()
      .filter((t) => t.sender.track?.kind === "video")
      .forEach((t) => t.setCodecPreferences?.(sorted));
  } catch { /* older browsers: just use the default codec */ }
}

/**
 * Chrome normally starts a video call at ~300 kbps and ramps up over many seconds,
 * which is why the picture starts blurry. These Chrome-only hints in the connection
 * description ask it to start (and stay) higher. Other browsers ignore them.
 */
function boostBitrateHints(sdp, maxKbps) {
  // Start moderately high so the picture isn't blurry for the first seconds, but don't force a
  // minimum: on a slow upload, a forced floor causes packet loss, which makes things worse.
  const startKbps = Math.min(1500, maxKbps);
  const lines = sdp.split("\r\n");
  let inVideo = false;
  const videoPayloads = new Set();
  // First pass: find the real video codecs (not rtx/red/fec helpers) in the video section.
  lines.forEach((l) => {
    if (l.startsWith("m=")) inVideo = l.startsWith("m=video");
    const m = inVideo && l.match(/^a=rtpmap:(\d+) (H264|VP8|VP9|AV1)\//i);
    if (m) videoPayloads.add(m[1]);
  });
  return lines
    .map((l) => {
      const m = l.match(/^a=fmtp:(\d+) (.*)$/);
      if (!m || !videoPayloads.has(m[1]) || l.includes("x-google-start-bitrate")) return l;
      return `${l};x-google-start-bitrate=${startKbps};x-google-max-bitrate=${maxKbps}`;
    })
    .join("\r\n");
}

// How much to shrink the captured picture to reach a target height (never enlarge).
function scaleFor(sender, targetHeight) {
  const srcHeight = sender.track?.getSettings?.().height || 1080;
  return targetHeight ? Math.max(1, srcHeight / targetHeight) : 1;
}

async function applyQuality(pc, q, targetHeight) {
  const sender = pc.getSenders().find((s) => s.track?.kind === "video");
  if (!sender) return;
  const params = sender.getParameters();
  if (!params.encodings?.length) params.encodings = [{}];
  params.encodings[0].maxBitrate = q.maxBitrate;
  params.encodings[0].maxFramerate = q.maxFramerate;
  params.encodings[0].scaleResolutionDownBy = scaleFor(sender, targetHeight ?? q.targetHeight);
  params.degradationPreference = q.degradation;
  try {
    await sender.setParameters(params);
  } catch {
    // Some browsers reject degradationPreference — retry without it so the bitrate still applies.
    delete params.degradationPreference;
    try { await sender.setParameters(params); } catch { /* ignore */ }
  }
}

/**
 * Handles the WebRTC side of the app.
 * - The sharer keeps one RTCPeerConnection per viewer and sends them its tab (video + audio).
 * - A viewer keeps one RTCPeerConnection to the sharer and receives the stream.
 */
export function useScreenShare({ selfId, sharerId }) {
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [connState, setConnState] = useState("idle"); // idle | connecting | connected | failed
  const [hasAudio, setHasAudio] = useState(false);
  const [quality, setQualityState] = useState("auto");
  const [stats, setStats] = useState(null); // live numbers shown on the video
  const [attempt, setAttempt] = useState(0); // bumps on every stream request, re-arms the safety net

  const localRef = useRef(null);
  const peersRef = useRef(new Map()); // peerId -> RTCPeerConnection
  const chainRef = useRef(Promise.resolve()); // process signals one at a time, in order
  const qualityRef = useRef(QUALITY.auto);
  // Auto mode state per viewer connection: current ladder step + a pending change waiting for confirmation.
  const autoRef = useRef(new WeakMap());
  const sharerRef = useRef(sharerId);
  sharerRef.current = sharerId;
  const retryRef = useRef({ timer: null, count: 0 });

  const isSharer = !!selfId && sharerId === selfId;

  // Viewer: ask the sharer for a fresh video connection (after a drop, or if it never arrived).
  const requestStream = useCallback(() => {
    const sharer = sharerRef.current;
    if (!sharer || sharer === clientId || localRef.current) return;
    setConnState("connecting");
    setAttempt((a) => a + 1);
    socket.emit("viewer-ready");
  }, []);

  const scheduleRetry = useCallback((delayMs) => {
    const r = retryRef.current;
    clearTimeout(r.timer);
    r.timer = setTimeout(() => {
      r.count += 1;
      requestStream();
    }, delayMs ?? Math.min(1000 * 2 ** r.count, 10000)); // 1s, 2s, 4s… up to 10s
  }, [requestStream]);

  const closePeer = (id) => {
    const pc = peersRef.current.get(id);
    if (pc) {
      pc.close();
      peersRef.current.delete(id);
    }
  };

  const closeAll = () => {
    peersRef.current.forEach((pc) => pc.close());
    peersRef.current.clear();
  };

  const makePeer = (peerId) => {
    closePeer(peerId);
    const pc = new RTCPeerConnection({ iceServers });
    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit("signal", { to: peerId, data: { type: "candidate", candidate: e.candidate } });
    };
    peersRef.current.set(peerId, pc);
    return pc;
  };

  // Change quality live, for everyone currently watching.
  const setQuality = useCallback((key) => {
    const q = QUALITY[key] || QUALITY.auto;
    qualityRef.current = q;
    setQualityState(key);
    peersRef.current.forEach((pc) => {
      autoRef.current.delete(pc); // Auto restarts its measuring from 1080p
      applyQuality(pc, q);
    });
  }, []);

  // ----- Sharer: start / stop -----
  const startShare = useCallback(async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("Screen sharing isn't supported in this browser. Use Chrome or Edge on a computer.");
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({
      // Ask for full HD; the tab is captured at its real on-screen size, up to this.
      video: { frameRate: { ideal: 30, max: 30 }, width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 } },
      // Turn off voice-call processing: it ruins music and movie sound.
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: "include",
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
      preferCurrentTab: false,
    });

    const [videoTrack] = stream.getVideoTracks();
    // "motion" tunes the encoder for film rather than slides/text. Note: on its own it also
    // tells Chrome to drop resolution under pressure — the quality preset overrides that.
    if (videoTrack) videoTrack.contentHint = "motion";
    videoTrack?.addEventListener("ended", () => stopShare()); // user clicked the browser's "Stop sharing"
    const [audioTrack] = stream.getAudioTracks();
    if (audioTrack) audioTrack.contentHint = "music"; // full-range audio, not speech-optimised

    const res = await new Promise((r) => socket.emit("start-share", r));
    if (res?.error) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error(res.error);
    }
    localRef.current = stream;
    setLocalStream(stream);
    setHasAudio(stream.getAudioTracks().length > 0);
    return { hasAudio: stream.getAudioTracks().length > 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopShare = useCallback(() => {
    localRef.current?.getTracks().forEach((t) => t.stop());
    localRef.current = null;
    setLocalStream(null);
    setHasAudio(false);
    setStats(null);
    closeAll();
    socket.emit("stop-share");
  }, []);

  // ----- Signaling handlers -----
  useEffect(() => {
    const onViewerReady = async ({ from }) => {
      const stream = localRef.current;
      if (!stream) return;
      const pc = makePeer(from);
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      preferCodecs(pc);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("signal", { to: from, data: { type: "offer", sdp: pc.localDescription } });
    };

    const handleSignal = async ({ from, data }) => {
      if (data.type === "offer") {
        // I'm a viewer receiving the sharer's stream.
        const pc = makePeer(from);
        setConnState("connecting");
        pc.ontrack = (e) => setRemoteStream(e.streams[0]);
        pc.onconnectionstatechange = () => {
          if (peersRef.current.get(from) !== pc) return; // an older, replaced connection
          const s = pc.connectionState;
          if (s === "connected") {
            setConnState("connected");
            clearTimeout(retryRef.current.timer);
            retryRef.current.count = 0;
          } else if (s === "failed") {
            setConnState("failed");
            scheduleRetry(); // try again on our own instead of leaving a frozen screen
          } else if (s === "disconnected") {
            // Often recovers by itself within a few seconds; if not, reconnect.
            scheduleRetry(5000);
          } else if (s === "connecting" || s === "new") setConnState("connecting");
        };
        await pc.setRemoteDescription(data.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("signal", { to: from, data: { type: "answer", sdp: pc.localDescription } });
      } else if (data.type === "answer") {
        // I'm the sharer: the viewer accepted. Apply bitrate hints, then the quality preset.
        const pc = peersRef.current.get(from);
        if (!pc) return;
        const q = qualityRef.current;
        const boosted = { type: "answer", sdp: boostBitrateHints(data.sdp.sdp, Math.round(q.maxBitrate / 1000)) };
        try {
          await pc.setRemoteDescription(boosted);
        } catch {
          await pc.setRemoteDescription(data.sdp); // hints rejected: fall back to the original
        }
        applyQuality(pc, q);
      } else if (data.type === "candidate") {
        const pc = peersRef.current.get(from);
        if (pc) await pc.addIceCandidate(data.candidate).catch(() => {});
      }
    };

    const onSignal = (msg) => {
      chainRef.current = chainRef.current.then(() => handleSignal(msg)).catch((e) => console.warn("signal error", e));
    };

    const onShareStopped = () => {
      if (!localRef.current) {
        closeAll();
        setRemoteStream(null);
        setStats(null);
        setConnState("idle");
      }
    };

    const onPeerLeft = ({ id }) => closePeer(id);

    socket.on("viewer-ready", onViewerReady);
    socket.on("signal", onSignal);
    socket.on("share-stopped", onShareStopped);
    socket.on("peer-left", onPeerLeft);
    return () => {
      socket.off("viewer-ready", onViewerReady);
      socket.off("signal", onSignal);
      socket.off("share-stopped", onShareStopped);
      socket.off("peer-left", onPeerLeft);
    };
  }, []);

  // ----- Live stats: what resolution / fps / bitrate is actually flowing -----
  useEffect(() => {
    let prev = null;
    let tick = 0;

    // Auto mode: every 2 seconds, look at how fast we can upload to each viewer and move
    // up or down the ladder. A change must show up twice in a row before we act on it.
    const runAuto = (pc, report) => {
      const q = qualityRef.current;
      if (!q.adaptive || !localRef.current) return;
      let avail = 0;
      let target = 0;
      report.forEach((r) => {
        if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") avail = r.availableOutgoingBitrate || 0;
        if (r.type === "outbound-rtp" && r.kind === "video") target = r.targetBitrate || 0;
      });
      const bps = avail && target ? Math.min(avail, target) : avail || target;
      if (!bps) return;
      const st = autoRef.current.get(pc) || { step: 0, pending: null, seen: 0 };
      const want = pickStep(bps / 1e6, st.step);
      if (want === st.step) {
        st.pending = null;
        st.seen = 0;
      } else if (want === st.pending) {
        st.seen += 1;
        if (st.seen >= 2) {
          st.step = want;
          st.pending = null;
          st.seen = 0;
          applyQuality(pc, q, AUTO_LADDER[want].height);
        }
      } else {
        st.pending = want;
        st.seen = 1;
      }
      autoRef.current.set(pc, st);
    };

    const timer = setInterval(async () => {
      tick += 1;
      const pcs = [...peersRef.current.values()];
      const pc = pcs[0];
      if (!pc) return setStats(null);
      // Auto mode runs for every viewer separately (each may have a different connection).
      if (tick % 2 === 0) {
        for (const other of pcs.slice(1)) {
          const r = await other.getStats().catch(() => null);
          if (r) runAuto(other, r);
        }
      }
      const report = await pc.getStats().catch(() => null);
      if (!report) return;
      if (tick % 2 === 0) runAuto(pc, report);
      let video = null;
      let pair = null;
      report.forEach((r) => {
        if (r.kind === "video" && (r.type === "inbound-rtp" || r.type === "outbound-rtp")) video = r;
        if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") pair = r;
      });
      if (!video) return;
      const bytes = video.bytesReceived ?? video.bytesSent ?? 0;
      const mbps = prev ? ((bytes - prev.bytes) * 8) / ((video.timestamp - prev.t) * 1000) : 0;
      prev = { bytes, t: video.timestamp };
      let codec = "";
      if (video.codecId) codec = report.get(video.codecId)?.mimeType?.replace("video/", "") || "";
      setStats({
        width: video.frameWidth || 0,
        height: video.frameHeight || 0,
        fps: Math.round(video.framesPerSecond || 0),
        mbps: Math.max(0, mbps),
        codec,
        // Only on the sharer's side: why Chrome is holding quality back, if it is.
        limitedBy: video.qualityLimitationReason && video.qualityLimitationReason !== "none" ? video.qualityLimitationReason : null,
        rttMs: pair?.currentRoundTripTime ? Math.round(pair.currentRoundTripTime * 1000) : null,
        // Sharer only: Chrome's estimate of how fast we can upload to this viewer right now.
        uploadMbps: pair?.availableOutgoingBitrate ? pair.availableOutgoingBitrate / 1e6 : null,
        auto: !!qualityRef.current.adaptive,
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // When someone else is sharing, ask them for the stream.
  useEffect(() => {
    if (sharerId && selfId && sharerId !== selfId) {
      retryRef.current.count = 0;
      requestStream();
    }
    if (!sharerId && !localRef.current) {
      clearTimeout(retryRef.current.timer);
      closeAll();
      setRemoteStream(null);
      setConnState("idle");
    }
  }, [sharerId, selfId, requestStream]);

  // Viewer safety net: if we're "connecting" for too long, ask again.
  useEffect(() => {
    if (connState !== "connecting") return;
    const t = setTimeout(() => scheduleRetry(0), 12000);
    return () => clearTimeout(t);
  }, [connState, attempt, scheduleRetry]);

  const reconnect = useCallback(() => {
    retryRef.current.count = 0;
    requestStream();
  }, [requestStream]);

  /**
   * Called after every (re)join with what the server thinks. Fixes mismatches such as:
   * - I'm still sharing, but the server forgot (it restarted) -> claim the share again
   * - The server says I'm sharing, but I'm not (I refreshed the page) -> release it
   */
  const reconcile = useCallback((serverSharerId) => {
    const sharingHere = !!localRef.current;
    if (sharingHere && !serverSharerId) {
      socket.emit("start-share", () => {});
    } else if (sharingHere && serverSharerId !== clientId) {
      stopShare(); // someone else took over while we were away
    } else if (!sharingHere && serverSharerId === clientId) {
      socket.emit("stop-share");
    }
  }, [stopShare]);

  // Stop everything when leaving the page.
  useEffect(() => () => {
    clearTimeout(retryRef.current.timer);
    localRef.current?.getTracks().forEach((t) => t.stop());
    closeAll();
  }, []);

  return {
    isSharer, localStream, remoteStream, connState, hasAudio,
    quality, setQuality, stats,
    startShare, stopShare, reconnect, reconcile,
  };
}