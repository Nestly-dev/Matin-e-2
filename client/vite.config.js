import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development, Vite runs on :5173 and forwards API + socket traffic to the Node server on :4000.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // lets phones/laptops on the same Wi-Fi open it via your local IP
    proxy: {
      "/api": "http://localhost:4000",
      "/socket.io": { target: "http://localhost:4000", ws: true },
    },
  },
});
