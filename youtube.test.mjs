import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { projectDir } from "./pipeline.mjs";
import { upload, fitTags, notReady } from "./youtube.mjs";

test("tags are cut to YouTube's 500-character total", () => {
  assert.deepEqual(fitTags(["a", "b c"]), ["a", "b c"]);
  assert.equal(fitTags(Array(100).fill("x".repeat(20))).join(",").length <= 500, true);
});

test("upload: token, resumable start, bytes, thumbnail, captions; a refused thumbnail is only a warning", async (t) => {
  const job = { id: randomUUID(), lang: "en", finals: ["final-v1.mp4"], subFiles: ["en", "te"],
    publish: { youtube_title: "T", youtube_description: "D", tags: ["t"], hashtags: ["#H"], instagram_caption: "C", x_post: "X" } };
  const dir = projectDir(job);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "renders"), { recursive: true });
  fs.mkdirSync(path.join(dir, "subtitles"));
  fs.writeFileSync(path.join(dir, "renders/final-v1.mp4"), "video");
  fs.writeFileSync(path.join(dir, "renders/thumb.jpg"), "jpg");
  for (const l of job.subFiles) fs.writeFileSync(path.join(dir, `subtitles/${l}.srt`), "1\n00:00:00,000 --> 00:00:01,000\nHi\n");
  Object.assign(process.env, { YOUTUBE_CLIENT_ID: "i", YOUTUBE_CLIENT_SECRET: "s", YOUTUBE_REFRESH_TOKEN: "r" });
  t.after(() => { for (const k of ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"]) delete process.env[k]; });

  const calls = [];
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (url.includes("oauth2")) return Response.json({ access_token: "a" });
    if (url.includes("uploadType=resumable")) return new Response(null, { headers: { location: "https://up/session" } });
    if (url === "https://up/session") return Response.json({ id: "vid1" });
    if (url.includes("thumbnails")) return new Response("forbidden", { status: 403 });
    return Response.json({});
  };
  const yt = await upload(job, path.join(dir, "renders/thumb.jpg"), "2030-01-01T00:00:00.000Z");
  assert.deepEqual(calls.map((c) => new URL(c.url).pathname), ["/token", "/upload/youtube/v3/videos", "/session", "/upload/youtube/v3/thumbnails/set", "/upload/youtube/v3/captions", "/upload/youtube/v3/captions"]);
  const meta = JSON.parse(calls[1].opts.body);
  assert.equal(meta.status.privacyStatus, "private");
  assert.equal(meta.status.publishAt, "2030-01-01T00:00:00.000Z");
  assert.match(meta.snippet.description, /#H$/);
  assert.equal(yt.url, "https://youtu.be/vid1");
  assert.equal(yt.warnings.length, 1);
  assert.match(yt.warnings[0], /Thumbnail/);
});

test("not ready without the keys", () => {
  assert.match(notReady(), /YOUTUBE_CLIENT_ID/);
});

test("upload: a network failure on the thumbnail or captions is a warning, not a second upload", async (t) => {
  const job = { id: randomUUID(), lang: "en", finals: ["final-v1.mp4"], subFiles: ["en"],
    publish: { youtube_title: "T", youtube_description: "D", tags: [], hashtags: [], instagram_caption: "C", x_post: "X" } };
  const dir = projectDir(job);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "renders"), { recursive: true });
  fs.mkdirSync(path.join(dir, "subtitles"));
  fs.writeFileSync(path.join(dir, "renders/final-v1.mp4"), "video");
  fs.writeFileSync(path.join(dir, "renders/thumb.jpg"), "jpg");
  fs.writeFileSync(path.join(dir, "subtitles/en.srt"), "1\n00:00:00,000 --> 00:00:01,000\nHi\n");
  Object.assign(process.env, { YOUTUBE_CLIENT_ID: "i", YOUTUBE_CLIENT_SECRET: "s", YOUTUBE_REFRESH_TOKEN: "r" });
  t.after(() => { for (const k of ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"]) delete process.env[k]; });
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  globalThis.fetch = async (url) => {
    if (url.includes("oauth2")) return Response.json({ access_token: "a" });
    if (url.includes("uploadType=resumable")) return new Response(null, { headers: { location: "https://up/session" } });
    if (url === "https://up/session") return Response.json({ id: "vid2" });
    throw new TypeError("fetch failed"); // thumbnail and captions: the network drops
  };
  const yt = await upload(job, path.join(dir, "renders/thumb.jpg"));
  assert.equal(yt.id, "vid2");
  assert.equal(yt.warnings.length, 2);
});
