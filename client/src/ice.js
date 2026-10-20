// Shared by screen sharing and voice chat.
// STUN lets two browsers discover their public addresses so they can connect directly.
// On some strict networks (some campus/mobile networks) a TURN relay is also needed — see README.
export const iceServers = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];
if (import.meta.env.VITE_TURN_URL) {
  iceServers.push({
    urls: import.meta.env.VITE_TURN_URL,
    username: import.meta.env.VITE_TURN_USERNAME,
    credential: import.meta.env.VITE_TURN_CREDENTIAL,
  });
}
