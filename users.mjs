// Studio accounts, in one JSON file. The first account is the owner; everyone after that waits for the owner's approval.
// Passwords are scrypt hashes. API keys are never kept here: every account's work uses the server's .env.local.
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOCK_AFTER = 5, LOCK_MS = 15 * 60_000;
const RESET_MS = 60 * 60_000, RESET_GAP_MS = 60_000; // a reset link lasts an hour; one email a minute per account
const badPassword = (p) => (typeof p !== "string" || p.length < 8 || p.length > 200 ? "Use a password of at least 8 characters" : null);
const sha = (s) => createHash("sha256").update(s).digest("base64url");

const hash = (password, salt) => scryptSync(password, salt, 64).toString("base64url");

export function userStore(file) {
  const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : []);
  const write = (users) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const failures = new Map(); // email -> { n, until }; in memory, so a restart clears it
  // What the browser may see: never the password hash.
  const pub = (u) => u && { id: u.id, email: u.email, role: u.role, status: u.status, createdAt: u.createdAt, ...(u.mustChange && { mustChange: true }) };
  const setPassword = (u, password) => { u.salt = randomBytes(16).toString("base64url"); u.hash = hash(password, u.salt); };
  const matches = (u, password) => typeof password === "string" && timingSafeEqual(Buffer.from(hash(password, u.salt)), Buffer.from(u.hash));

  return {
    pub,
    find: (id) => read().find((u) => u.id === id) ?? null,
    list: () => read().map(pub),
    // Returns { user } or { error }.
    signUp(email, password) {
      email = typeof email === "string" ? email.trim().toLowerCase() : "";
      if (!EMAIL.test(email) || email.length > 200) return { error: "Enter a valid email address" };
      if (badPassword(password)) return { error: badPassword(password) };
      const users = read();
      if (users.some((u) => u.email === email)) return { error: "An account with that email already exists; sign in instead" };
      const salt = randomBytes(16).toString("base64url");
      const owner = users.length === 0;
      const user = { id: randomUUID(), email, salt, hash: hash(password, salt), role: owner ? "owner" : "editor", status: owner ? "approved" : "pending", createdAt: new Date().toISOString() };
      write([...users, user]);
      return { user };
    },
    // Returns { user } or { error }. The same words for an unknown email and a wrong password.
    signIn(email, password, now = Date.now()) {
      email = typeof email === "string" ? email.trim().toLowerCase() : "";
      const f = failures.get(email);
      if (f?.until > now) return { error: "Too many wrong tries. Wait 15 minutes and try again" };
      const user = read().find((u) => u.email === email);
      const ok = !!user && matches(user, password);
      if (!ok) {
        const n = (f?.until > 0 ? 0 : f?.n ?? 0) + 1;
        failures.set(email, n >= LOCK_AFTER ? { n: 0, until: now + LOCK_MS } : { n });
        return { error: "That email and password don't match an account" };
      }
      failures.delete(email);
      if (user.status !== "approved") return { error: "Your account is waiting for the owner's approval" };
      return { user };
    },
    // Forgot password: a one-time link token for this email, or null (no such account, or one was sent a minute ago).
    // Only the token's hash is stored, so the users file alone can't be used to reset anyone.
    startReset(email, now = Date.now()) {
      email = typeof email === "string" ? email.trim().toLowerCase() : "";
      const users = read(), u = users.find((x) => x.email === email);
      if (!u || (u.resetAt && now - u.resetAt < RESET_GAP_MS)) return null;
      const token = randomBytes(32).toString("base64url");
      Object.assign(u, { resetHash: sha(token), resetExp: now + RESET_MS, resetAt: now });
      write(users);
      return { token, email: u.email };
    },
    // Sets the new password from a reset link; the link then stops working, and so do sign-ins made with the old password.
    finishReset(token, password, now = Date.now()) {
      if (badPassword(password)) return { error: badPassword(password) };
      const users = read(), u = typeof token === "string" && token ? users.find((x) => x.resetHash && x.resetExp > now && x.resetHash === sha(token)) : null;
      if (!u) return { error: "This reset link has expired or was already used. Ask for a new one" };
      setPassword(u, password);
      delete u.resetHash; delete u.resetExp; delete u.mustChange;
      write(users);
      failures.delete(u.email);
      return { user: u };
    },
    // From the account panel: needs the current password. Ends every other sign-in (the session key includes the hash).
    changePassword(id, current, password) {
      const users = read(), u = users.find((x) => x.id === id);
      if (!u || !matches(u, current)) return { error: "Your current password is not right" };
      if (badPassword(password)) return { error: badPassword(password) };
      if (password === current) return { error: "Pick a new password, not the current one" };
      setPassword(u, password);
      delete u.mustChange;
      write(users);
      return { user: u };
    },
    // The owner resets someone's password: a one-time temporary password, which must be changed after signing in.
    tempPassword(id) {
      const users = read(), u = users.find((x) => x.id === id);
      if (!u || u.role === "owner") return { error: "No such account" };
      const password = randomBytes(9).toString("base64url");
      setPassword(u, password);
      u.mustChange = true;
      write(users);
      failures.delete(u.email);
      return { password };
    },
    endSessions(id) {
      const users = read(), u = users.find((x) => x.id === id);
      if (u) { u.session = (u.session ?? 0) + 1; write(users); }
    },
    setStatus(id, status) {
      const users = read(), u = users.find((x) => x.id === id);
      if (!u || u.role === "owner") return "No such account";
      if (status === "removed") write(users.filter((x) => x.id !== id));
      else if (status === "approved") { u.status = "approved"; write(users); }
      else return "Approve or remove";
      return null;
    },
  };
}
