// Matinée server
// Job 1: keep track of rooms and who is in them.
// Job 2: pass WebRTC "connection setup" messages between browsers (signaling).
// Job 3: relay chat messages and emoji reactions.
// The video itself never touches this server: it goes browser-to-browser.
//
// People are identified by a clientId that their browser tab keeps, NOT by their socket id.
// A socket id changes every time the connection blips; the clientId doesn't. That way a
// 3-second Wi-Fi hiccup doesn't look like "the sharer left".

const path = require("path");
const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");
const { catalogRouter, isTmdbImage } = require("./catalog");

const PORT = process.env.PORT || 4000;
// How long someone can be disconnected before we treat them as gone.
const GRACE_MS = 30 * 1000;

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  // Be patient with tabs in the background or flaky Wi-Fi before calling a connection dead.
  pingInterval: 20000,
  pingTimeout: 40000,
});

// roomId -> {
//   members: Map<clientId, { name, color, socketId|null, leaveTimer }>,
//   sharerId: clientId|null,
// }
const rooms = new Map();

const COLORS = ["#ff7a59", "#ffc857", "#7bdff2", "#b892ff", "#7ee081", "#ff8fab"];

function makeRoomId() {
  const words = ["popcorn", "velvet", "reel", "matinee", "encore", "balcony", "cinema", "frame", "spotlight", "marquee"];
  const word = words[Math.floor(Math.random() * words.length)];
  const code = Math.random().toString(36).slice(2, 6);
  return `${word}-${code}`;
}

// Movie sync state. Instead of sending video, everyone plays their own copy and follows this.
// "position" is where the movie was at server time "updatedAt"; if playing, it has moved on since.
function freshSync() {
  return { source: null, playing: false, position: 0, updatedAt: Date.now(), byId: null, by: null, reason: null };
}

function cleanSource(src) {
  if (!src || typeof src !== "object") return null;
  const url = typeof src.url === "string" && /^https?:\/\//i.test(src.url) && src.url.length < 2000 ? src.url : null;
  return {
    name: String(src.name || "Movie").slice(0, 120),
    duration: Number.isFinite(src.duration) && src.duration > 0 ? src.duration : null,
    url,
  };
}

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = { members: new Map(), sharerId: null, mode: "share", sync: freshSync(), pick: null, chat: [] };
    rooms.set(roomId, room);
  }
  return room;
}

function roomSnapshot(roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  return {
    roomId,
    sharerId: room.sharerId,
    mode: room.mode,
    sync: room.sync,
    pick: room.pick,
    members: [...room.members].map(([id, m]) => ({ id, name: m.name, color: m.color, online: !!m.socketId, mic: !!m.mic })),
  };
}

// Where the movie is right now, according to the shared state.
function syncPosition(sync) {
  return sync.playing ? sync.position + (Date.now() - sync.updatedAt) / 1000 : sync.position;
}

// Actually remove someone (called once their grace period runs out).
function removeMember(roomId, clientId) {
  const room = rooms.get(roomId);
  const m = room?.members.get(clientId);
  if (!m) return;
  room.members.delete(clientId);
  if (room.sharerId === clientId) {
    room.sharerId = null;
    io.to(roomId).emit("share-stopped");
  }
  io.to(roomId).emit("peer-left", { id: clientId });
  io.to(roomId).emit("room-state", roomSnapshot(roomId));
  io.to(roomId).emit("system", { text: `${m.name} left` });
  // Clean up empty rooms after 10 minutes so links survive a quick break.
  if (room.members.size === 0) {
    setTimeout(() => {
      const r = rooms.get(roomId);
      if (r && r.members.size === 0) rooms.delete(roomId);
    }, 10 * 60 * 1000);
  }
}

// --- REST: create a room / check a room exists ---
// "Tonight's pick": the movie a room was opened for (from the browse page). Display only.
function cleanPick(p) {
  if (!p || typeof p !== "object" || !Number.isInteger(p.id)) return null;
  return {
    id: p.id,
    type: p.type === "tv" ? "tv" : "movie",
    title: String(p.title || "").slice(0, 120),
    year: Number.isInteger(p.year) ? p.year : null,
    poster: isTmdbImage(p.poster) ? p.poster : null,
    backdrop: isTmdbImage(p.backdrop) ? p.backdrop : null,
  };
}

app.post("/api/rooms", (req, res) => {
  let id = makeRoomId();
  while (rooms.has(id)) id = makeRoomId();
  const room = getRoom(id);
  room.pick = cleanPick(req.body?.pick);
  // Rooms opened for a specific movie start in Movie sync, the full-quality mode.
  if (room.pick) room.mode = "sync";
  res.json({ roomId: id });
});

// Movie listings (trending, new releases, search…) — see catalog.js
app.use("/api/catalog", catalogRouter);

// Render pings this to check the server is alive before sending people to it.
app.get("/api/health", (req, res) => res.json({ ok: true, rooms: rooms.size }));

app.get("/api/rooms/:id", (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ exists: false });
  res.json({ exists: true, people: room.members.size });
});

// --- Realtime ---
io.on("connection", (socket) => {
  let currentRoom = null;
  let myId = null; // this person's clientId

  const me = () => rooms.get(currentRoom)?.members.get(myId);

  socket.on("join-room", ({ roomId, name, clientId, mic }, ack) => {
    if (typeof roomId !== "string" || !roomId) return ack?.({ error: "Bad room link." });
    const id = typeof clientId === "string" && clientId.length <= 64 ? clientId : socket.id;
    const room = getRoom(roomId); // links still work after a server restart
    const cleanName = String(name || "Guest").slice(0, 24);

    const existing = room.members.get(id);
    if (existing) {
      // Same person coming back (connection blip or page refresh): pick up where they were.
      clearTimeout(existing.leaveTimer);
      existing.leaveTimer = null;
      const oldSocketId = existing.socketId;
      existing.socketId = socket.id;
      // If their old connection is somehow still open (e.g. a duplicated tab), retire it.
      if (oldSocketId && oldSocketId !== socket.id) {
        const old = io.sockets.sockets.get(oldSocketId);
        if (old) {
          old.emit("replaced");
          old.disconnect(true);
        }
      }
      existing.name = cleanName;
      existing.mic = !!mic; // after a page refresh the mic is off again
    } else {
      if (room.members.size >= 8) return ack?.({ error: "Room is full (8 people max)." });
      const color = COLORS[room.members.size % COLORS.length];
      room.members.set(id, { name: cleanName, color, socketId: socket.id, leaveTimer: null, mic: !!mic });
    }

    socket.join(roomId);
    currentRoom = roomId;
    myId = id;

    // Recent chat comes along, so late joiners (and refreshes) see the conversation so far.
    ack?.({ ok: true, self: id, rejoined: !!existing, state: roomSnapshot(roomId), history: room.chat });
    socket.to(roomId).emit("room-state", roomSnapshot(roomId));
    if (!existing) socket.to(roomId).emit("system", { text: `${cleanName} joined the room` });
  });

  // Someone starts sharing their screen/tab. Only one sharer at a time.
  socket.on("start-share", (ack) => {
    const room = rooms.get(currentRoom);
    if (!room || !me()) return ack?.({ error: "Not in a room." });
    if (room.mode === "sync") return ack?.({ error: "Switch to Screen share first." });
    if (room.sharerId && room.sharerId !== myId) {
      return ack?.({ error: "Someone else is already sharing." });
    }
    const wasSharing = room.sharerId === myId;
    room.sharerId = myId;
    ack?.({ ok: true });
    io.to(currentRoom).emit("room-state", roomSnapshot(currentRoom));
    if (!wasSharing) socket.to(currentRoom).emit("system", { text: `${me().name} started sharing` });
  });

  socket.on("stop-share", () => {
    const room = rooms.get(currentRoom);
    if (!room || room.sharerId !== myId) return;
    room.sharerId = null;
    io.to(currentRoom).emit("share-stopped");
    io.to(currentRoom).emit("room-state", roomSnapshot(currentRoom));
  });

  // A viewer says "I'm ready, send me the stream" -> forwarded to the sharer.
  socket.on("viewer-ready", () => {
    const room = rooms.get(currentRoom);
    const sharer = room?.sharerId && room.members.get(room.sharerId);
    if (sharer?.socketId && room.sharerId !== myId) {
      io.to(sharer.socketId).emit("viewer-ready", { from: myId });
    }
  });

  // WebRTC signaling relay: offers, answers and ICE candidates, addressed by clientId.
  socket.on("signal", ({ to, data }) => {
    const target = rooms.get(currentRoom)?.members.get(to);
    if (!target?.socketId || !myId) return; // only relay inside the same room
    io.to(target.socketId).emit("signal", { from: myId, data });
  });

  // Voice chat: same relay idea as "signal", but on its own channel so voice and
  // screen-share setup messages never get mixed up.
  socket.on("voice-signal", ({ to, data }) => {
    const target = rooms.get(currentRoom)?.members.get(to);
    if (!target?.socketId || !myId || to === myId) return;
    io.to(target.socketId).emit("voice-signal", { from: myId, data });
  });

  // Mic on/off, so everyone's avatar can show it.
  socket.on("voice-state", ({ mic }) => {
    const m = me();
    if (!m || m.mic === !!mic) return;
    m.mic = !!mic;
    io.to(currentRoom).emit("room-state", roomSnapshot(currentRoom));
  });

  // ---------- Movie sync ----------
  // Clock check: lets each browser work out how far its clock is from the server's.
  socket.on("time", (ack) => typeof ack === "function" && ack(Date.now()));

  const broadcastSync = (action) => {
    io.to(currentRoom).emit("room-state", roomSnapshot(currentRoom));
    if (action) io.to(currentRoom).emit("sync-event", { ...action, byId: myId, by: me()?.name });
  };

  socket.on("set-mode", ({ mode }) => {
    const room = rooms.get(currentRoom);
    if (!room || !me() || !["share", "sync"].includes(mode) || room.mode === mode) return;
    room.mode = mode;
    if (mode === "sync" && room.sharerId) {
      room.sharerId = null; // screen sharing and movie sync don't run at the same time
      io.to(currentRoom).emit("share-stopped");
    }
    if (mode === "share" && room.sync.playing) {
      room.sync = { ...room.sync, playing: false, position: syncPosition(room.sync), updatedAt: Date.now() };
    }
    io.to(currentRoom).emit("room-state", roomSnapshot(currentRoom));
    io.to(currentRoom).emit("system", { text: `${me().name} switched to ${mode === "sync" ? "Movie sync" : "Screen share"}` });
  });

  // Choose the room's movie (or clear it with null to pick a new one).
  socket.on("sync-source", (src) => {
    const room = rooms.get(currentRoom);
    if (!room || !me()) return;
    room.sync = { ...freshSync(), source: src ? { ...cleanSource(src), byId: myId, by: me().name } : null };
    broadcastSync(src ? { action: "source", name: room.sync.source.name } : { action: "cleared" });
  });

  // Fill in the duration once the first player has loaded the file.
  socket.on("sync-duration", ({ duration }) => {
    const room = rooms.get(currentRoom);
    if (!room?.sync.source || room.sync.source.duration || !(duration > 0)) return;
    room.sync.source.duration = duration;
    io.to(currentRoom).emit("room-state", roomSnapshot(currentRoom));
  });

  // Play / pause / seek from anyone in the room.
  socket.on("sync-action", ({ action, position, reason }) => {
    const room = rooms.get(currentRoom);
    if (!room?.sync.source || !me() || !["play", "pause", "seek"].includes(action)) return;
    const pos = Number.isFinite(position) && position >= 0 ? position : syncPosition(room.sync);
    const playing = action === "play" ? true : action === "pause" ? false : room.sync.playing;
    room.sync = {
      ...room.sync, playing, position: pos, updatedAt: Date.now(),
      byId: myId, by: me().name, reason: action === "pause" && reason === "buffering" ? "buffering" : null,
    };
    broadcastSync({ action, position: pos, reason: room.sync.reason });
  });

  // After a server restart the room is blank. The first person who still has the movie
  // loaded puts back where everyone was, instead of everyone jumping to the start.
  socket.on("sync-restore", (snap) => {
    const room = rooms.get(currentRoom);
    if (!room || !me() || room.sync.source || !snap?.source) return;
    room.mode = "sync";
    room.sync = {
      ...freshSync(), source: { ...cleanSource(snap.source), byId: snap.source.byId || myId, by: snap.source.by || me().name },
      playing: !!snap.playing, position: Math.max(0, Number(snap.position) || 0), updatedAt: Date.now(),
    };
    io.to(currentRoom).emit("room-state", roomSnapshot(currentRoom));
  });

  socket.on("chat", ({ text, replyTo }) => {
    const m = me();
    const room = rooms.get(currentRoom);
    if (!m || !room || !text?.trim()) return;
    // A reply carries a short quote of the original. We take it from the server's copy of the
    // message (not from the sender), so nobody can put words in someone else's mouth.
    const original = replyTo ? room.chat.find((c) => c.id === replyTo) : null;
    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      from: myId,
      name: m.name,
      color: m.color,
      text: String(text).trim().slice(0, 500),
      at: Date.now(),
      reply: original
        ? { id: original.id, from: original.from, name: original.name, color: original.color, text: original.text.slice(0, 140) }
        : null,
    };
    room.chat.push(msg);
    if (room.chat.length > 100) room.chat.shift(); // keep only the most recent 100
    io.to(currentRoom).emit("chat", msg);
  });

  socket.on("reaction", ({ emoji }) => {
    const allowed = ["😂", "😱", "😭", "❤️", "🔥", "🍿"];
    if (!currentRoom || !allowed.includes(emoji)) return;
    io.to(currentRoom).emit("reaction", { emoji, from: myId });
  });

  socket.on("disconnect", () => {
    const m = me();
    // Ignore if this person already reconnected on a newer socket.
    if (!m || m.socketId !== socket.id) return;
    m.socketId = null;
    io.to(currentRoom).emit("room-state", roomSnapshot(currentRoom)); // shows them as "reconnecting"
    const roomId = currentRoom;
    const id = myId;
    m.leaveTimer = setTimeout(() => removeMember(roomId, id), GRACE_MS);
  });
});

// In production, serve the built React app from the same server.
const clientDist = path.join(__dirname, "..", "client", "dist");
// Built JS/CSS files have unique names, so they can be cached forever.
app.use("/assets", express.static(path.join(clientDist, "assets"), { immutable: true, maxAge: "1y" }));
// A missing asset (e.g. an old file name after a rebuild) must be a real 404,
// not the HTML page — otherwise the browser tries to run HTML as JavaScript and shows a blank screen.
app.use("/assets", (req, res) => res.status(404).send("Not found"));
app.use(express.static(clientDist, { index: false }));
app.get(/^\/(?!api|socket\.io).*/, (req, res) => {
  // Never cache the page itself, so every visit picks up the latest build.
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(clientDist, "index.html"), (err) => {
    if (err) res.status(200).send("Client not built yet. Run the client dev server, or `npm run build` in /client.");
  });
});

server.listen(PORT, () => console.log(`🎬 Matinée server running on http://localhost:${PORT}`));