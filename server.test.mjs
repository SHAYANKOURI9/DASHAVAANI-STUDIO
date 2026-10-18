import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseRange } from "./range.mjs";
import { allowedHost, showIntroFirst, isLocal, rateLimit } from "./auth.mjs";
import { jobStore } from "./jobs.mjs";

test("a video Range header is read, and impossible ranges are refused instead of crashing", () => {
  assert.equal(parseRange(undefined, 1000), null, "no header: whole file");
  assert.deepEqual(parseRange("bytes=0-", 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange("bytes=100-199", 1000), { start: 100, end: 199 });
  assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=900-5000", 1000), { start: 900, end: 999 }, "end past the file is cut to the file");
  for (const bad of ["bytes=999999999-", "bytes=500-100", "bytes=-0", "bytes=1000-"]) assert.equal(parseRange(bad, 1000), "bad", bad);
});

test("only this machine's own names may reach the server (no DNS rebinding)", () => {
  for (const ok of ["localhost:4000", "127.0.0.1:4000", "localhost:5173", "localhost", "[::1]:4000"]) assert.equal(allowedHost(ok), true, ok);
  for (const no of ["evil.example:4000", "localhost.evil.example", "127.0.0.1.nip.io:4000", "", undefined]) assert.equal(allowedHost(no), false, String(no));
  // Online: a Cloudflare quick tunnel's address, or the studio's own PUBLIC_HOST.
  assert.equal(allowedHost("calm-river-12.trycloudflare.com"), true);
  assert.equal(allowedHost("studio.example.com", "studio.example.com"), true);
  for (const no of ["trycloudflare.com.evil.example", "a.b.trycloudflare.com", "studio.example.com.evil.example"]) assert.equal(allowedHost(no, "studio.example.com"), false, no);
  assert.equal(isLocal("localhost:4000"), true);
  assert.equal(isLocal("calm-river-12.trycloudflare.com"), false);
});

test("the job store ignores stray files and never leaves a half-written job", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-"));
  const store = jobStore(dir);
  const id = "00000000-0000-4000-8000-000000000001";
  store.save({ id, status: "done" });
  fs.writeFileSync(path.join(dir, ".DS_Store"), "\0\0binary");
  assert.deepEqual(store.all().map((j) => j.id), [id], "a .DS_Store does not break the list");
  assert.deepEqual(fs.readdirSync(dir).sort(), [".DS_Store", `${id}.json`], "no temp file left behind");
  assert.equal(store.load(id).status, "done");
  assert.equal(store.load("../../etc/passwd"), null);
  fs.rmSync(dir, { recursive: true });
});

test("each time the server starts, the plain address opens the intro first; links into the studio never do", () => {
  const run = "r2";
  assert.equal(showIntroFirst("", undefined, run), true, "fresh browser, plain address");
  assert.equal(showIntroFirst("", "theme=dark", run), true, "other cookies don't count");
  assert.equal(showIntroFirst("", "dv_intro=r2", run), false, "intro already seen since this server started");
  assert.equal(showIntroFirst("", "a=b; dv_intro=r2", run), false);
  assert.equal(showIntroFirst("", "dv_intro=r1", run), true, "seen in an earlier run of the server: show it again");
  assert.equal(showIntroFirst("", "dv_intro=1", run), true, "the old once-per-session cookie no longer skips it");
  assert.equal(showIntroFirst("?job=00000000-0000-4000-8000-000000000001", undefined, run), false, "a story link opens the story");
  assert.equal(showIntroFirst("?view=bulletins", undefined, run), false);
});

test("the intro's showcase: the owner's finished stories unless hidden, watch only, never other accounts'", async () => {
  const { showcase, showcaseMedia } = await import("./jobs.mjs");
  const done = { id: "00000000-0000-4000-8000-00000000000a", status: "done", lang: "te", format: "landscape", group: "g", script: { headline: "H", narration: "secret script" }, input: "source text", cost: { total: 9 }, finals: ["final-v1.mp4", "final-v2.mp4"], source: { title: "Wire", name: "PIB" }, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z" };
  const draft = { ...done, id: "00000000-0000-4000-8000-00000000000b", status: "draft_review", finals: undefined, draft: "draft.mp4" };
  const [s, ...rest] = showcase([draft, done], "owner-id");
  assert.equal(rest.length, 0, "drafts and work in progress stay private");
  assert.deepEqual(showcase([{ ...done, onIntro: false }], "owner-id"), [], "a video the owner hid");
  assert.equal(showcaseMedia(`/media/${done.id}/poster.jpg`, () => ({ ...done, onIntro: false }), "owner-id"), false, "nor its poster");
  assert.deepEqual(showcase([{ ...done, createdBy: "editor-id" }], "owner-id"), [], "another account's video is never on the intro");
  assert.equal(showcaseMedia(`/media/${done.id}/final-v2.mp4`, () => ({ ...done, createdBy: "editor-id" }), "owner-id"), false);
  assert.equal(showcase([{ ...done, createdBy: "owner-id" }], "owner-id").length, 1, "the owner's own new stories are shown");
  assert.deepEqual(s, { id: done.id, lang: "te", format: "landscape", group: "g", headline: "H", final: "final-v2.mp4", sourceTitle: "Wire", sourceName: "PIB", updatedAt: done.updatedAt });
  const load = (id) => [done, draft].find((j) => j.id === id) ?? null;
  assert.equal(showcaseMedia(`/media/${done.id}/poster.jpg`, load, "owner-id"), true);
  assert.equal(showcaseMedia(`/media/${done.id}/final-v2.mp4`, load, "owner-id"), true);
  for (const p of [`/media/${done.id}/voice.wav`, `/media/${done.id}/draft.mp4`, `/media/${done.id}/final-v9.mp4`, `/media/${done.id}/download/final-v2.mp4`, `/media/${draft.id}/poster.jpg`, `/media/${draft.id}/draft.mp4`, "/media/bulletins/x.mp4", "/media/nope/poster.jpg"])
    assert.equal(showcaseMedia(p, load, "owner-id"), false, p);
});

test("a story is seen only by its maker and the owner; old stories are the owner's", async () => {
  const { visibleTo } = await import("./jobs.mjs");
  const owner = { id: "o", role: "owner" }, a = { id: "a", role: "editor" }, b = { id: "b", role: "editor" };
  const mine = { id: "1", createdBy: "a" }, old = { id: "2" };
  assert.equal(visibleTo(mine, a), true);
  assert.equal(visibleTo(mine, b), false, "another editor");
  assert.equal(visibleTo(mine, owner), true);
  assert.equal(visibleTo(old, a), false, "stories from before accounts are the owner's");
  assert.equal(visibleTo(old, owner), true);
  assert.equal(visibleTo(mine, null), false, "not signed in");
  assert.equal(visibleTo(null, owner), false);
});

test("sign-in, sign-up and reset requests are limited per visitor", () => {
  const hit = rateLimit(3, 60_000);
  assert.deepEqual([hit("1.2.3.4", 0), hit("1.2.3.4", 1), hit("1.2.3.4", 2), hit("1.2.3.4", 3)], [true, true, true, false]);
  assert.equal(hit("5.6.7.8", 3), true, "another visitor is not affected");
  assert.equal(hit("1.2.3.4", 60_001), true, "the window passes");
});

test("caps: 20 stories a day for an editor (by India's date), and a monthly spend limit for everyone when set", async () => {
  const { overCap } = await import("./jobs.mjs");
  const ed = { id: "e", role: "editor" }, owner = { id: "o", role: "owner" };
  const day = (n, at) => Array.from({ length: n }, () => ({ createdBy: "e", createdAt: at }));
  const now = new Date("2026-10-15T10:00:00Z");
  assert.equal(overCap(day(19, "2026-10-15T01:00:00Z"), ed, { daily: 20 }, now), null);
  assert.match(overCap(day(20, "2026-10-15T01:00:00Z"), ed, { daily: 20 }, now), /20 stories a day/);
  assert.equal(overCap(day(20, "2026-10-14T18:00:00Z"), ed, { daily: 20 }, now), null, "23:30 in India yesterday doesn't count");
  assert.equal(overCap(day(20, "2026-10-14T19:00:00Z"), ed, { daily: 20 }, now) !== null, true, "00:30 in India today does");
  assert.equal(overCap(day(30, "2026-10-15T01:00:00Z").map((j) => ({ ...j, createdBy: "x" })), ed, { daily: 20 }, now), null, "other accounts' stories");
  assert.equal(overCap([], owner, { daily: 20, monthCap: 0, spent: 99999 }, now), null, "no cap set");
  for (const who of [owner, ed]) assert.match(overCap([], who, { daily: 20, monthCap: 500, spent: 500 }, now), /₹500/, `${who.role} stopped at the cap`);
  assert.equal(overCap(day(50, "2026-10-15T01:00:00Z").map((j) => ({ ...j, createdBy: "o" })), owner, { daily: 20, monthCap: 500, spent: 10 }, now), null, "the owner has no daily limit");
});
