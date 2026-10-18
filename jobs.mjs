// Jobs as JSON files, one per story. Only *.json counts (macOS drops .DS_Store into opened folders), and a save
// goes to a temp file first, so a crash mid-write never leaves a half-written job the server can't read.
import fs from "node:fs";
import path from "node:path";

export function jobStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (id) => path.join(dir, `${id}.json`);
  return {
    load: (id) => /^[a-f0-9-]{36}$/.test(id) && fs.existsSync(file(id)) ? JSON.parse(fs.readFileSync(file(id), "utf8")) : null,
    save(job) {
      const tmp = `${file(job.id)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...job, updatedAt: new Date().toISOString() }, null, 2));
      fs.renameSync(tmp, file(job.id));
    },
    all: () => fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))),
  };
}

// The intro's showcase for visitors who aren't signed in: the owner's finished stories, watch only, and only what a viewer sees
// (headline, language, the newest final). Scripts, sources' text, costs, drafts and voices stay behind the sign-in.
// Who may open a story: its maker, and the owner (who also owns every story made before accounts existed).
export const visibleTo = (job, user) => !!job && !!user && (user.role === "owner" || job.createdBy === user.id);

// The owner's finished stories are shown unless the owner hid one (onIntro: false); other accounts' videos never are.
// ownerId: the owner account's id (stories from before accounts have no createdBy and are the owner's).
const onIntro = (j, ownerId) => j.onIntro !== false && (!j.createdBy || j.createdBy === ownerId) && j.status === "done" && !!j.finals?.length;
export const showcase = (jobs, ownerId) => jobs.filter((j) => onIntro(j, ownerId) && j.script?.headline)
  .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt))
  .map((j) => ({ id: j.id, lang: j.lang, format: j.format ?? "landscape", group: j.group, headline: j.script.headline, final: j.finals.at(-1), sourceTitle: j.source?.title, sourceName: j.source?.name, updatedAt: j.updatedAt ?? j.createdAt }));
// A finished story's poster or one of its finals: what the showcase plays.
export function showcaseMedia(pathname, load, ownerId) {
  const m = /^\/media\/([a-f0-9-]{36})\/(poster\.jpg|final-v\d+\.mp4)$/.exec(pathname);
  const job = m && load(m[1]);
  return !!job && onIntro(job, ownerId) && (m[2] === "poster.jpg" || job.finals.includes(m[2]));
}

// Limits on new stories: an editor files at most `daily` a day (India's date), and when MONTHLY_CAP_INR is set nobody
// files once this month's spend reaches it (all work runs on the server's keys, so all of it counts).
const istDay = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
export function overCap(jobs, user, { daily, monthCap = 0, spent = 0 }, now = new Date()) {
  if (monthCap && spent >= monthCap) return `This month's spending reached the studio's ₹${monthCap} limit (MONTHLY_CAP_INR in .env.local)`;
  if (user.role === "owner") return null;
  const today = jobs.filter((j) => j.createdBy === user.id && istDay(j.createdAt) === istDay(now)).length;
  return today >= daily ? `You can file ${daily} stories a day. Try again tomorrow` : null;
}
