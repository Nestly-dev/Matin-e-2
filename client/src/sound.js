// Small notification chimes, made on the fly with the browser's audio engine (no sound files).
// Browsers keep sound off until the person has clicked or typed on the page, so we
// wake the audio engine up on the first interaction.

let ctx = null;

function getCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

const wake = () => getCtx()?.resume?.().catch(() => {});
window.addEventListener("pointerdown", wake, { passive: true });
window.addEventListener("keydown", wake);

// "message": two quick soft notes going up. "reply": three notes, so a reply to you stands out.
const TUNES = {
  message: [880, 1318.5],
  reply: [659.25, 880, 1174.7],
};

export function playChime(kind = "message") {
  const c = getCtx();
  if (!c) return;
  if (c.state !== "running") {
    c.resume?.().catch(() => {});
    return; // not allowed to make sound yet (nobody has clicked the page)
  }
  const start = c.currentTime + 0.01;
  (TUNES[kind] || TUNES.message).forEach((freq, i) => {
    const t = start + i * 0.09;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    // Quick fade in, gentle fade out: a soft "ding", not a beep. Kept quiet so it
    // doesn't drown out the movie.
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.1, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.4);
  });
}