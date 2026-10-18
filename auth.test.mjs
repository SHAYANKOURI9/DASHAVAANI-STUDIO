import { test } from "node:test";
import assert from "node:assert/strict";
import { isOpen } from "./auth.mjs";

test("only the intro, sign-in and sign-up are open; every other page, video and action needs an account", () => {
  for (const [m, p] of [["GET", "/intro"], ["GET", "/intro/film.mp4"], ["GET", "/login"], ["GET", "/signup"], ["GET", "/assets/login-abc.js"], ["GET", "/fonts/AnekLatin.ttf"], ["GET", "/favicon.svg"], ["GET", "/api/stats"], ["GET", "/api/showcase"], ["GET", "/templates/vt03-breaking.jpg"], ["GET", "/api/inbox"], ["POST", "/api/login"], ["POST", "/api/signup"], ["GET", "/forgot"], ["GET", "/reset"], ["POST", "/api/forgot"], ["POST", "/api/reset"]])
    assert.equal(isOpen(m, p), true, `${m} ${p}`);
  for (const [m, p] of [["GET", "/"], ["GET", "/api/jobs"], ["GET", "/api/jobs/abc"], ["GET", "/media/x/final-v1.mp4"], ["GET", "/api/usage"], ["GET", "/templates/c-1234abcd.jpg"], ["GET", "/api/me"], ["GET", "/api/users"], ["POST", "/api/jobs"], ["POST", "/api/logout"], ["POST", "/api/me/keys"], ["GET", "/intro/../data/users.json"], ["GET", "/loginx"]])
    assert.equal(isOpen(m, p), false, `${m} ${p}`);
});
