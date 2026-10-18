import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionToken, sessionUser, cookieUser, safeNext } from "./auth.mjs";

const NOW = Date.UTC(2026, 9, 13, 12);
const UID = "00000000-0000-4000-8000-000000000001";
const cookie = (v) => `theme=dark; dv_session=${v}`;

test("a sign-in names its account, lasts 12 hours, and can't be forged or stretched", () => {
  const tok = sessionToken("secret", UID, NOW);
  assert.equal(sessionUser(cookie(tok), "secret", NOW + 60_000), UID);
  assert.equal(sessionUser(cookie(tok), "secret", NOW + 13 * 3600_000), null, "expired");
  assert.equal(sessionUser(cookie(tok), "other-secret", NOW), null, "a new server secret signs everyone out");
  const [uid, exp, sig] = tok.split(".");
  assert.equal(sessionUser(cookie(`${uid}.${Number(exp) + 999999}.${sig}`), "secret", NOW), null, "a stretched expiry breaks the signature");
  assert.equal(sessionUser(cookie(`${UID.replace("1", "2")}.${exp}.${sig}`), "secret", NOW), null, "another account's id breaks the signature");
  assert.equal(sessionUser("theme=dark", "secret", NOW), null, "no cookie");
  assert.equal(sessionUser(undefined, "secret", NOW), null);
  assert.equal(sessionUser(cookie("garbage"), "secret", NOW), null);
});

test("after signing in, only a path on this site is followed", () => {
  assert.equal(safeNext("/?job=abc"), "/?job=abc");
  assert.equal(safeNext("/#desk"), "/#desk");
  for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "", undefined]) assert.equal(safeNext(bad), "/", String(bad));
});

test("a new password ends older sign-ins: the cookie is checked with a key that includes the password hash", () => {
  const tok = sessionToken("secret:old-hash", UID, NOW);
  assert.equal(cookieUser(cookie(tok)), UID);
  assert.equal(sessionUser(cookie(tok), "secret:old-hash", NOW), UID);
  assert.equal(sessionUser(cookie(tok), "secret:new-hash", NOW), null);
  assert.equal(cookieUser("theme=dark"), null);
});
