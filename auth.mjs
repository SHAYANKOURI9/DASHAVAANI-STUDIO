// Every page and every action needs a signed-in account; only the intro, sign-in and sign-up are open.
// The sign-in is a cookie "<userId>.<expiry>.<signature>", signed with the server secret: it survives restarts,
// needs nothing stored, and a removed account is refused because its user no longer exists.
import { createHmac, timingSafeEqual } from "node:crypto";

const HOURS = 12;
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const sign = (secret, uid, exp) => createHmac("sha256", secret).update(`${uid}.${exp}`).digest("base64url");

export const sessionToken = (secret, uid, now = Date.now()) => { const exp = now + HOURS * 3600_000; return `${uid}.${exp}.${sign(secret, uid, exp)}`; };
// The signed-in user's id, or null.
export function sessionUser(cookie, secret, now = Date.now()) {
  const m = /(?:^|;\s*)dv_session=([0-9a-f-]{36})\.(\d+)\.([\w-]+)/.exec(cookie ?? "");
  return m && Number(m[2]) > now && same(m[3], sign(secret, m[1], m[2])) ? m[1] : null;
}
export const SESSION_HOURS = HOURS;
// The account a sign-in cookie claims, before checking it: the check's key includes that account's password hash,
// so a new password (forgot password, reset) ends every older sign-in.
export const cookieUser = (cookie) => /(?:^|;\s*)dv_session=([0-9a-f-]{36})\./.exec(cookie ?? "")?.[1] ?? null;

// Open to everyone: the intro (and its film), the sign-in and sign-up pages, and what those pages load: the house
// template pictures, the public wire, and the showcase of finished stories (their videos are checked in server.mjs).
export const isOpen = (method, pathname) =>
  (["GET", "HEAD"].includes(method) && /^\/(intro(\/[\w-]+\.(mp4|jpg))?|login|signup|forgot|reset|favicon\.(svg|ico)|assets\/[\w.-]+|fonts\/[\w-]+\.(ttf|woff2)|templates\/vt[\w-]+\.jpg|api\/(stats|showcase|inbox))$/.test(pathname))
  || (method === "POST" && ["/api/login", "/api/signup", "/api/forgot", "/api/reset"].includes(pathname));

// Where to go after signing in: a path on this site only, never another site.
export const safeNext = (next) => (typeof next === "string" && /^\/(?![\/\\])/.test(next) ? next : "/");

// This machine's own names, plus the public address when online: a Cloudflare quick tunnel (one name under
// trycloudflare.com, which only Cloudflare hands out) or PUBLIC_HOST. A page elsewhere that points its own domain at
// 127.0.0.1 (DNS rebinding) is still refused.
export const isLocal = (host) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host ?? "");
export const allowedHost = (host, publicHost = process.env.PUBLIC_HOST) =>
  isLocal(host) || /^[a-z0-9-]+\.trycloudflare\.com$/.test(host ?? "") || (!!publicHost && host === publicHost);

// At most n requests per key (a visitor's address) in a window; the per-email lockout in users.mjs comes on top.
export function rateLimit(n, ms) {
  const seen = new Map();
  return (key, now = Date.now()) => {
    const recent = (seen.get(key) ?? []).filter((t) => now - t < ms);
    if (seen.size > 10_000) seen.clear(); // shortcut: crude memory cap; fine for one studio
    seen.set(key, [...recent, now]);
    return recent.length < n;
  };
}

// The plain studio address opens the intro first each time the server starts: /intro sets a cookie naming this run,
// and only that run's cookie skips it (a browser that restores its session keeps old cookies, so a plain "seen it"
// would hide the intro for good). Links into the studio itself (?job=…, ?view=…) always open where they point.
export const showIntroFirst = (search, cookie, run) => !search && !new RegExp(`(?:^|;\\s*)dv_intro=${run}(?:;|$)`).test(cookie ?? "");
