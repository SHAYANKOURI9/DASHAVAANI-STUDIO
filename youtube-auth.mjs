// Run once: npm run youtube:auth. Signs in to the YouTube channel in the browser and prints the
// YOUTUBE_REFRESH_TOKEN line to paste into .env.local. Needs YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET
// from a Google Cloud OAuth client of type "Desktop app", with the YouTube Data API v3 enabled.
import http from "node:http";
import { randomUUID } from "node:crypto";

const { YOUTUBE_CLIENT_ID: id, YOUTUBE_CLIENT_SECRET: secret } = process.env;
if (!id || !secret) {
  console.error("Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env.local first.");
  process.exit(1);
}
const PORT = 4200, redirect = `http://127.0.0.1:${PORT}`, state = randomUUID();
const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
  client_id: id, redirect_uri: redirect, response_type: "code", access_type: "offline", prompt: "consent", state,
  scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl",
})}`;

const server = http.createServer(async (req, res) => {
  const q = new URL(req.url, redirect).searchParams;
  if (!q.get("code") && !q.get("error")) return res.writeHead(404).end();
  try {
    if (q.get("state") !== state) throw new Error("state did not match; start again");
    if (q.get("error")) throw new Error(q.get("error"));
    const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ code: q.get("code"), client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: "authorization_code" }) });
    const data = await r.json();
    if (!data.refresh_token) throw new Error(data.error_description ?? "no refresh token returned");
    res.end("Signed in. Return to the terminal.");
    console.log(`\nAdd this line to .env.local, then restart the server:\n\nYOUTUBE_REFRESH_TOKEN=${data.refresh_token}\n`);
  } catch (e) {
    res.end(`Sign-in failed: ${e.message}`);
    console.error("Sign-in failed:", e.message);
    process.exitCode = 1;
  }
  server.close();
});
server.listen(PORT, "127.0.0.1", () => console.log(`Open this link and sign in with the channel's Google account:\n\n${url}\n`));
