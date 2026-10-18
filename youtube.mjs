// YouTube upload: the latest final, its publish pack, thumbnail and subtitle tracks. Always private (or scheduled):
// a person makes it public in YouTube Studio. Plain fetch against the YouTube Data API v3; no Google SDK.
import fs from "node:fs";
import path from "node:path";
import { projectDir, LANGS } from "./pipeline.mjs";

const KEYS = ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"];
export const notReady = () => {
  const missing = KEYS.filter((k) => !process.env[k]);
  return missing.length ? `${missing.join(", ")} not set in .env.local (run npm run youtube:auth once)` : null;
};

async function ok(res, what) {
  if (res.ok) return res;
  throw new Error(`YouTube ${what} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
}

async function accessToken() {
  const res = await ok(await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ client_id: process.env.YOUTUBE_CLIENT_ID, client_secret: process.env.YOUTUBE_CLIENT_SECRET, refresh_token: process.env.YOUTUBE_REFRESH_TOKEN, grant_type: "refresh_token" }),
  }), "sign-in");
  return (await res.json()).access_token;
}

// YouTube caps all tags together at 500 characters.
export function fitTags(tags, max = 500) {
  const out = [];
  let len = 0;
  for (const t of tags) {
    const cost = t.length + (t.includes(" ") ? 2 : 0) + (out.length ? 1 : 0);
    if (len + cost > max) break;
    out.push(t);
    len += cost;
  }
  return out;
}

export async function upload(job, thumbFile, publishAt) {
  const problem = notReady();
  if (problem) throw new Error(problem);
  const p = job.publish;
  const file = path.join(projectDir(job), "renders", job.finals.at(-1));
  const auth = { Authorization: `Bearer ${await accessToken()}` };
  const meta = {
    snippet: {
      title: p.youtube_title, description: [p.youtube_description, p.hashtags.join(" ")].filter(Boolean).join("\n\n"), tags: fitTags(p.tags),
      categoryId: "25", defaultLanguage: job.lang, defaultAudioLanguage: job.lang, // 25 = News & Politics
    },
    status: { privacyStatus: "private", ...(publishAt && { publishAt }), selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
  };
  const start = await ok(await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": String(fs.statSync(file).size) },
    body: JSON.stringify(meta),
  }), "upload start");
  const video = await (await ok(await fetch(start.headers.get("location"), { method: "PUT", headers: { ...auth, "Content-Type": "video/mp4" }, body: fs.readFileSync(file) }), "upload")).json();

  // The video is up; thumbnail and captions are extras, so their failures are warnings.
  const warnings = [];
  // A thrown network error counts as a warning too: failing the step now would make Retry upload the video again.
  const extra = (call) => call().catch((e) => ({ ok: false, status: e.message }));
  if (thumbFile) {
    const res = await extra(() => fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${video.id}`, { method: "POST", headers: { ...auth, "Content-Type": "image/jpeg" }, body: fs.readFileSync(thumbFile) }));
    if (!res.ok) warnings.push(`Thumbnail not set (${res.status}); custom thumbnails need a verified channel and a file under 2 MB`);
  }
  for (const lang of job.subFiles ?? []) {
    const boundary = `dv${Date.now()}`;
    const srt = fs.readFileSync(path.join(projectDir(job), "subtitles", `${lang}.srt`), "utf8");
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ snippet: { videoId: video.id, language: lang, name: LANGS[lang]?.name ?? lang } })}\r\n`
      + `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n${srt}\r\n--${boundary}--`;
    const res = await extra(() => fetch("https://www.googleapis.com/upload/youtube/v3/captions?uploadType=multipart&part=snippet", { method: "POST", headers: { ...auth, "Content-Type": `multipart/related; boundary=${boundary}` }, body }));
    if (!res.ok) warnings.push(`${LANGS[lang]?.name ?? lang} subtitles not added (${res.status})`);
  }
  return { id: video.id, url: `https://youtu.be/${video.id}`, at: new Date().toISOString(), publishAt: publishAt ?? null, file: job.finals.at(-1), warnings };
}
