import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// The Node server (server.mjs, port 4000) owns the API, media, fonts and template thumbnails.
const api = "http://localhost:4000"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  server: { proxy: { "/api": api, "/media": api, "/fonts": api, "/templates": api } },
  build: {
    rolldownOptions: {
      // Three pages: the studio (index.html), the scroll-driven intro (/intro) and the sign-in page (/login).
      input: { main: path.resolve(import.meta.dirname, "index.html"), intro: path.resolve(import.meta.dirname, "intro.html"), login: path.resolve(import.meta.dirname, "login.html") },
      // /fonts/* is served by the Node server at runtime, not bundled: saying so keeps the build quiet about it.
      external: [/^\/fonts\//],
    },
  },
})
