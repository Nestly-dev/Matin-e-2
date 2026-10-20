# Matinée 🍿

Watch movies together. One person shares a browser tab (for example Stremio Web) with its sound; everyone in the room sees and hears it live, with chat and emoji reactions.

## How it works

- **server/**: Node + Express + Socket.io. Creates rooms, tracks who's in them, relays chat/reactions, and passes WebRTC setup messages ("signaling") between browsers.
- **client/**: React + Vite. The UI, plus `useScreenShare.js`, which captures the tab with `getDisplayMedia` and sends it peer-to-peer with WebRTC.

The movie never goes through your server. It streams directly from the sharer's browser to each viewer.

## Run it locally

```bash
npm run install:all

# terminal 1
npm run dev:server     # http://localhost:4000

# terminal 2
npm run dev:client     # http://localhost:5173
```

Open http://localhost:5173, start a room, and open the link in a second tab to test.

## Watching a movie

1. Open your movie in **Chrome or Edge on a computer** (for Stremio, use https://web.stremio.com).
2. In the Matinée room, click **Share a tab** → choose the **Chrome Tab** option → pick the movie tab → make sure **Share tab audio** is on.
3. Play the movie in its own tab. Your friend sees and hears it in the room.

Viewers can watch on any device, including phones. Sharing needs a desktop Chrome/Edge (Safari and phones can't capture tab audio).

## Put it online (so your friend can join from anywhere)

It's one Node app that also serves the built React site. On Render, Railway or similar:

- **Build command:** `npm run build`
- **Start command:** `npm start`

It must be served over **HTTPS** (those hosts do this for you), because browsers only allow screen capture on secure pages.

## If the video won't connect

WebRTC tries to connect the two browsers directly. On some strict networks (some campus or mobile networks) that fails, and you need a **TURN relay** server. Add these to `client/.env` before building:

```
VITE_TURN_URL=turn:your-turn-host:3478
VITE_TURN_USERNAME=...
VITE_TURN_CREDENTIAL=...
```

Metered.ca and Twilio both offer TURN; Metered has a free tier.

## Limits worth knowing

- Up to 8 people per room. The sharer uploads one copy of the stream per viewer, so for 1–3 friends it's great; for big groups you'd need a media server (SFU).
- Netflix, Disney+ and similar block screen capture (you'll see a black screen). Stremio and most sites without DRM work.
- Rooms live in memory, so restarting the server clears them (links still work, since the room is recreated on join).
