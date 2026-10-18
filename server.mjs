// Dashavani Studio: one Node server, jobs stored as JSON files, steps run one at a time.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as P from "./pipeline.mjs";
import { SOURCES, inbox, validSource } from "./sources.mjs";
import * as D from "./designer.mjs";
import * as Y from "./youtube.mjs";
import { allowedHost, isLocal, rateLimit, showIntroFirst, sessionToken, sessionUser, cookieUser, isOpen, safeNext, SESSION_HOURS } from "./auth.mjs";
import { sendMail } from "./mail.mjs";
import { userStore } from "./users.mjs";
import { jobStore, showcase, showcaseMedia, visibleTo, overCap } from "./jobs.mjs";
import { parseRange } from "./range.mjs";
import { serialQueue } from "./queue.mjs";

const PORT = Number(process.env.PORT ?? 4000);
const RUN = randomUUID().slice(0, 8); // this run of the server: the intro shows first once per run
const JOBS = path.join(P.DATA, "jobs");

const { load, save, all: allJobs } = jobStore(JOBS);
const loadAny = load, allJobsAny = allJobs; // the whole studio, for the queue and the intro

// Signs the sign-in cookies. Made once and kept in data/ (never in git) unless set.
const SECRET_FILE = path.join(P.DATA, "session-secret");
if (!process.env.SESSION_SECRET && !fs.existsSync(SECRET_FILE)) { fs.mkdirSync(P.DATA, { recursive: true }); fs.writeFileSync(SECRET_FILE, randomBytes(32).toString("base64url"), { mode: 0o600 }); }
const SECRET = process.env.SESSION_SECRET || fs.readFileSync(SECRET_FILE, "utf8").trim();
const users = userStore(path.join(P.DATA, "users.json"));
// Signs an account's cookies. A new password, or signing out (which bumps session), ends all of them at once.
const sessionKey = (u) => `${SECRET}:${u.hash}:${u.session ?? 0}`;
// Content-Security-Policy: scripts only from this site, plus the built pages' own inline scripts (the theme switch,
// which must run before the page draws) by their hash. Read once from web/dist, so a rebuild needs a restart (npm start does both).
const inlineHashes = fs.existsSync(path.join(P.ROOT, "web/dist")) ? fs.readdirSync(path.join(P.ROOT, "web/dist")).filter((f) => f.endsWith(".html"))
  .flatMap((f) => [...fs.readFileSync(path.join(P.ROOT, "web/dist", f), "utf8").matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`)) : [];
const CSP = `default-src 'self'; script-src 'self' ${inlineHashes.join(" ")}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`;
const ownerId = () => users.list().find((u) => u.role === "owner")?.id;

// Photos the source published with the story, fetched once. A failed photo never stops the story.
async function sourcePhotos(job) {
  const src = SOURCES[job.source?.source];
  if (!src?.photos || job.photos) return;
  job.photos = [];
  for (const url of (await src.photos(job.source.id, job.lang).catch(() => [])).slice(0, 4)) {
    try {
      if (new URL(url).hostname !== src.photoHost) continue;
      const res = await fetch(url);
      const type = res.headers.get("content-type")?.split(";")[0];
      if (res.ok && P.PHOTO_TYPES[type]) await P.savePhoto(job, Buffer.from(await res.arrayBuffer()), type, src.name);
    } catch (e) { console.error(`[${job.id}] photo ${url}:`, e.message); }
  }
}

// ElevenLabs characters this month: their own numbers when the key may read them, otherwise what this app has sent.
// Read with the signed-in account's own key, so nobody sees another account's plan.
const credits = new Map();
async function voiceCredits(key, jobIds) {
  const hit = credits.get(key);
  if (key && hit && Date.now() - hit.at < 60_000) return hit.data;
  let data = { source: "app", used: P.voiceCharsThisMonth(undefined, jobIds), limit: Number(process.env.ELEVENLABS_MONTHLY_CHARS) || 10000 };
  if (key) {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": key } }).catch(() => null);
    if (res?.ok) {
      const sub = await res.json();
      data = { source: "elevenlabs", used: sub.character_count, limit: sub.character_limit, resetsAt: sub.next_character_count_reset_unix * 1000 };
    }
  }
  credits.set(key, { at: Date.now(), data });
  return data;
}

// The rendered story, with the intro, end card and music around it unless the editor turned them off, then subtitle tracks.
async function finish(job, story, name) {
  if (job.bumpers === false) fs.renameSync(path.join(P.projectDir(job), "renders", story), path.join(P.projectDir(job), "renders", name));
  else await P.assemble(job, story, name);
  await P.addSubtitleTracks(job, name, job.bumpers === false ? 0 : P.BUMPER.open);
  return name;
}

const STEPS = {
  script: async (job) => {
    await P.writeScript(job);
    await sourcePhotos(job);
    await P.backTranslate(job).catch((e) => console.error(`[${job.id}] English check:`, e.message)); // a check, never a blocker
  },
  voice: async (job) => { await P.voice(job); if (job.voiceChars) credits.at = 0; },
  // Builds the page from the script; or, for "Use this version", puts back the exact page that version was rendered
  // from (Studio edits included).
  compose: async (job) => {
    const saved = job.restorePage && path.join(P.projectDir(job), "versions", `v${job.restorePage}.html`);
    delete job.restorePage;
    if (saved && fs.existsSync(saved)) fs.copyFileSync(saved, path.join(P.projectDir(job), "index.html"));
    else await P.compose(job);
  },
  edit: async (job) => { await P.applyChange(job, job.changeRequest); },
  fixlang: P.fixLanguage,
  draft: async (job) => {
    // Every draft is kept as a version, with what changed and the story's cost so far.
    const n = (job.versions?.length ?? 0) + 1;
    // The page this draft is rendered from, kept with its version: Studio edits survive later changes to the page.
    const versions = path.join(P.projectDir(job), "versions");
    fs.mkdirSync(versions, { recursive: true });
    fs.copyFileSync(path.join(P.projectDir(job), "index.html"), path.join(versions, `v${n}.html`));
    const story = await P.render(job, `draft-v${n}.story`, "draft");
    await P.critic(job, story).catch((e) => { job.critic = { summary: `Quality check could not run: ${e.message}`, issues: [] }; });
    job.draft = await finish(job, story, `draft-v${n}.mp4`);
    const spent = ["script", "voice", "presenter"].reduce((t, k) => t + (job.cost?.[k]?.inr ?? 0), 0);
    job.versions = [...(job.versions ?? []), { n, at: new Date().toISOString(), draft: job.draft, script: job.script, presenter: job.presenter, subLangs: job.subLangs, burn: job.burn,
      note: job.changeNote ?? (n === 1 ? "First draft from the approved script" : "Draft made again"), request: job.changeRequest ?? null, spent: Math.round(spent * 100) / 100,
      voice: job.voiceChars ? `recorded, ${job.voiceChars} characters` : "reused" }];
    delete job.changeNote; delete job.changeRequest;
  },
  avatar: P.avatar,
  final: async (job) => {
    const n = (job.finals?.length ?? 0) + 1;
    const name = await finish(job, await P.render(job, `final-v${n}.story`), `final-v${n}.mp4`);
    job.finals = [...(job.finals ?? []), name];
    await STEPS.publish(job);
  },
  // Publishing text is a help, never a blocker: a failure leaves a note and the final stands.
  publish: async (job) => {
    try { job.publish = await P.publishPack(job); delete job.publishError; }
    catch (e) { console.error(`[${job.id}] publish pack:`, e.message); job.publishError = e.message; }
  },
  youtube: async (job) => {
    const late = job.youtubeAt && Date.parse(job.youtubeAt) <= Date.now(); // passed while queued or before a retry
    job.youtube = await Y.upload(job, await P.thumbnail(job), late ? undefined : job.youtubeAt);
    if (late) job.youtube.warnings.push("The release time had passed, so it was uploaded private without one; schedule it in YouTube Studio");
    delete job.youtubeAt;
  },
};

// Wire headlines already translated, per language, kept across restarts so each is paid for once.
const WIRE_CACHE = path.join(P.DATA, "wire-titles.json");
const wireCache = fs.existsSync(WIRE_CACHE) ? JSON.parse(fs.readFileSync(WIRE_CACHE, "utf8")) : {};
// Gemini can take a minute: the wire answers in English at once and translates in the background (one job per
// language at a time); the page asks again and gets the translated headlines once they are cached.
const wireBusy = {};
function translateLater(titles, lang) {
  wireBusy[lang] ??= P.translateHeadlines(titles, lang)
    .then((out) => { if (out.length === titles.length) titles.forEach((t, n) => { wireCache[`${lang}\u0000${t}`] = out[n]; }); fs.writeFileSync(WIRE_CACHE, JSON.stringify(wireCache)); })
    .catch((e) => console.error(`Wire headlines in ${lang}:`, e.message))
    .finally(() => { delete wireBusy[lang]; });
  return Promise.resolve(null); // nothing yet: localTitles shows English this time
}

// Single queue: never run two at once. A queued story shows how many are ahead of it.
const queue = serialQueue();

// Bulletins: several stories joined into one video (sting once, a wipe between stories, end card, one music bed).
const BULLETINS = path.join(P.DATA, "bulletins");
fs.mkdirSync(BULLETINS, { recursive: true });
const loadBulletin = (id) => /^b-[a-f0-9-]{36}$/.test(id) && fs.existsSync(path.join(BULLETINS, `${id}.json`)) ? JSON.parse(fs.readFileSync(path.join(BULLETINS, `${id}.json`), "utf8")) : null;
const saveBulletin = (b) => fs.writeFileSync(path.join(BULLETINS, `${b.id}.json`), JSON.stringify(b, null, 2));
function buildBulletin(b) {
  saveBulletin(b);
  const who = P.useKeys.getStore();
  queue.add(b.id, () => P.useKeys.run(who, async () => {
    try {
      Object.assign(b, { status: "making" }); saveBulletin(b);
      const segments = [];
      for (const id of b.stories) segments.push(await P.storySegment(load(id)));
      b.seconds = Math.round(await P.stitch(segments, b.format === "vertical", path.join(BULLETINS, `${b.id}.mp4`)));
      Object.assign(b, { status: "done", file: `${b.id}.mp4` });
    } catch (e) {
      console.error(`[${b.id}] bulletin failed:`, e);
      Object.assign(b, { status: "error", error: e.message });
    }
    saveBulletin(b);
  }));
}
function run(job, steps, after) {
  Object.assign(job, { status: "queued", error: null, pending: { steps, after } });
  save(job);
  // Owner-only steps (YouTube) still know who asked, even when they run later in the queue.
  const who = P.useKeys.getStore();
  queue.add(job.id, () => P.useKeys.run(who, async () => {
    try {
      for (const step of steps) {
        Object.assign(job, { status: step });
        save(job);
        await STEPS[step](job);
        job.pending.steps = job.pending.steps.slice(1); // retry resumes from the failed step, not the start
        save(job);
      }
      Object.assign(job, { status: after, pending: null });
    } catch (e) {
      console.error(`[${job.id}] ${job.status} failed:`, e);
      Object.assign(job, { status: "error", error: `${job.status}: ${e.message}` });
    }
    save(job);
  }));
}

const otherFormat = (job) => (job.format === "vertical" ? "landscape" : "vertical");
const hasTwin = (job) => !!job.group && allJobs().some((o) => o.group === job.group && o.lang === job.lang && (o.format ?? "landscape") === otherFormat(job));

// The same story in the other format, from the approved script. Voice and presenter come from the caches,
// so only the new layout is rendered; translations and photos are copied over.
// presenter: the twin's own choice; Shorts & Reels can go without the presenter even when landscape has one.
function makeTwin(job, presenter = job.twinPresenter ?? job.presenter) {
  job.group ??= randomUUID();
  save(job);
  const twin = {
    id: randomUUID(), createdAt: new Date().toISOString(), format: otherFormat(job),
    presenter,
    ...Object.fromEntries(["createdBy", "input", "lang", "brief", "source", "bumpers", "group", "script", "warnings", "subLangs", "burn", "subs", "subTrans", "photos"].filter((k) => job[k] !== undefined).map((k) => [k, job[k]])),
  };
  const photos = path.join(P.projectDir(job), "assets/photos");
  if (fs.existsSync(photos)) fs.cpSync(photos, path.join(P.projectDir(twin), "assets/photos"), { recursive: true });
  run(twin, ["voice", "compose", "draft"], "draft_review");
  return twin;
}

// body: { subLangs, burn } — subtitle tracks, and the one shown on the picture (or "off")
function setSubs(job, body) {
  const langs = Array.isArray(body.subLangs) ? [...new Set(body.subLangs)] : null;
  if (!langs || !langs.every((l) => Object.hasOwn(P.LANGS, l))) return "Subtitle languages must be supported languages";
  if (body.burn !== "off" && !langs.includes(body.burn)) return "The subtitles shown on the video must be one of the chosen languages, or none";
  Object.assign(job, { subLangs: langs, burn: body.burn });
}

const ACTIONS = {
  // body: { script } — the person's reviewed script
  "approve-script": (job, body) => {
    if (job.status !== "script_review") return "Script is not waiting for review";
    const script = body.script && typeof body.script === "object" ? P.dropUnused(body.script) : body.script;
    const parsed = P.Script.safeParse(script);
    if (!parsed.success) return P.scriptProblems(script).join("; ");
    if (parsed.data.template.startsWith("c-") && !P.isApprovedCustom(parsed.data.template)) return "That template is not approved";
    job.script = parsed.data;
    if (typeof body.presenter === "boolean") job.presenter = body.presenter;
    if (typeof body.bumpers === "boolean") job.bumpers = body.bumpers;
    if (body.subLangs !== undefined) {
      const problem = setSubs(job, body);
      if (problem) return problem;
    }
    job.warnings = P.unsupportedNumbers(job.script, job.input);
    run(job, ["voice", "compose", "draft"], "draft_review");
    // Filed for both formats: the other one follows from this approved script, queued after this one.
    if (job.bothFormats && !hasTwin(job)) makeTwin(job);
  },
  // body: { presenter? } — AI presenter or voice only for the new version; the same as this one when left out
  "convert": (job, body) => {
    if (!["draft_review", "done"].includes(job.status)) return "Make the draft first, then the other format";
    if (hasTwin(job)) return "This story already has that version";
    if (body.presenter !== undefined && typeof body.presenter !== "boolean") return "Presenter must be on or off";
    makeTwin(job, body.presenter ?? job.presenter);
  },
  // body: { request } — a change in plain words; makes the next version (the voice is reused if the narration is unchanged)
  "change": (job, body) => {
    if (!["draft_review", "done"].includes(job.status)) return "Changes can be asked for once there is a draft";
    if (typeof body.request !== "string" || !body.request.trim() || body.request.length > 500) return "Say the change in up to 500 characters";
    job.changeRequest = body.request.trim();
    run(job, ["edit", "voice", "compose", "draft"], "draft_review");
  },
  // body: { n } — go back to an earlier version's script and settings, as a new version
  "restore": (job, body) => {
    const v = job.versions?.find((x) => x.n === body.n);
    if (!v) return "No such version";
    if (!["draft_review", "done"].includes(job.status)) return "Versions can be restored once there is a draft";
    Object.assign(job, { script: v.script, presenter: v.presenter, subLangs: v.subLangs, burn: v.burn, changeNote: `Back to version ${v.n}`, restorePage: v.n });
    run(job, ["voice", "compose", "draft"], "draft_review");
  },
  // After editing the page in HyperFrames Studio: a new draft from it, listed as its own version.
  "studio-render": (job) => {
    if (job.status !== "draft_review") return "Studio edits are rendered while the draft is waiting for review";
    job.changeNote = "Studio edits";
    run(job, ["draft"], "draft_review");
  },
  "redo-draft": (job) => job.status !== "draft_review" ? "No draft to redo" : run(job, ["draft"], "draft_review"),
  // Voice-only stories skip HeyGen entirely.
  "approve-draft": (job) => job.status !== "draft_review" ? "Draft is not waiting for approval" : run(job, job.presenter === false ? ["final"] : ["avatar", "final"], "done"),
  "rerender": (job) => job.status !== "done" ? "Video is not finished yet" : run(job, ["final"], "done"),
  // body: { to? } — an earlier review stop; the nearest one when left out
  "back": (job, body) => {
    const targets = P.backTargets(job);
    const to = body.to ?? targets.at(-1);
    if (!targets.includes(to)) return "Can't go back to that step from here";
    Object.assign(job, { status: to, error: null, pending: null });
    delete job.changeRequest; delete job.changeNote;
    save(job);
  },
  // body: { input?, brief? } — rewrite the script, optionally from edited source text or brief
  // body: { narration } — record the voice again from edited narration, then remake the draft
  "revoice": (job, body) => {
    if (job.status !== "voice_review") return "Voice is not open for changes";
    const parsed = P.Script.safeParse({ ...job.script, narration: body.narration });
    if (!parsed.success) return P.scriptProblems({ ...job.script, narration: body.narration }).join("; ");
    job.script = parsed.data;
    job.warnings = P.unsupportedNumbers(job.script, job.input);
    run(job, ["voice", "compose", "draft"], "draft_review");
  },
  "keep-voice": (job) => job.status !== "voice_review" ? "Voice is not open for changes" : run(job, ["compose", "draft"], "draft_review"),
  "rewrite": (job, body) => {
    if (job.status !== "script_review") return "Script is not waiting for review";
    if (body.input !== undefined) {
      if (typeof body.input !== "string" || body.input.trim().length < 20 || body.input.length > 20000) return "Source text must be 20–20,000 characters";
      job.input = body.input.trim();
    }
    if (body.brief !== undefined) {
      if (typeof body.brief !== "string" || body.brief.length > 500) return "Brief must be at most 500 characters";
      job.brief = body.brief.trim();
    }
    run(job, ["script"], "script_review");
  },
  // Subtitles changed after the final: the page is set again and a new final made. The presenter comes from
  // the cache, so only new translations cost anything.
  // At draft review, without a new voice (no paid step, only the page and draft are made again): the words on screen
  // (script: category, headline, standfirst, ticker; not the spoken narration) and when each photo or clip shows
  // (at: { file: seconds }) or which are left out (off: [file]).
  "adjust": (job, body) => {
    if (job.status !== "draft_review") return "The draft can be adjusted while it is waiting for review";
    const SCREEN = ["category", "headline", "standfirst", "ticker"], text = body.script ?? {};
    if (typeof text !== "object" || Array.isArray(text) || Object.keys(text).some((k) => !SCREEN.includes(k))) return "Only the category, headline, standfirst and ticker can be changed here; ask for other changes in words";
    const parsed = P.Script.safeParse({ ...job.script, ...text });
    if (!parsed.success) return P.scriptProblems({ ...job.script, ...text }).join("; ") || "That text can't be used";
    const files = new Set((job.photos ?? []).map((p) => p.file)), at = body.at ?? job.cutawayAt ?? {}, off = body.off ?? job.cutawayOff ?? [];
    if (typeof at !== "object" || Array.isArray(at) || !Array.isArray(off)) return "Those cutaway settings can't be used";
    if (![...Object.keys(at), ...off].every((f) => files.has(f))) return "That photo or clip is not in this story";
    if (!Object.values(at).every((t) => typeof t === "number" && t >= 0 && t <= (job.seconds ?? 0))) return "Pick a time within the story";
    const same = SCREEN.every((k) => JSON.stringify(parsed.data[k]) === JSON.stringify(job.script[k])) && JSON.stringify(at) === JSON.stringify(job.cutawayAt ?? {}) && JSON.stringify(off) === JSON.stringify(job.cutawayOff ?? []);
    if (same) return "Nothing changed";
    Object.assign(job, { script: parsed.data, cutawayAt: at, cutawayOff: off, warnings: P.unsupportedNumbers(parsed.data, job.input) });
    run(job, ["compose", "draft"], "draft_review");
  },
  "subtitles": (job, body) => {
    if (job.status !== "done") return "Video is not finished yet";
    const problem = setSubs(job, body);
    if (problem) return problem;
    run(job, ["compose", ...(job.presenter === false ? [] : ["avatar"]), "final"], "done");
  },
  // Wrong-language text (a quote left in the speaker's language, a word slipped into another script) is fixed in place;
  // past script review the voice (only if the narration changed), page and draft are made again.
  "fix-language": (job) => {
    if (job.status === "script_review") return run(job, ["fixlang"], "script_review");
    if (!["draft_review", "done", "error"].includes(job.status) || !job.script) return "Fix the language once there is a script";
    run(job, ["fixlang", "voice", "compose", "draft"], "draft_review");
  },
  "publish-pack": (job) => job.status !== "done" ? "Video is not finished yet" : run(job, ["publish"], "done"),
  // body: { publishAt? } — an ISO time for a scheduled release; the video stays private until then
  "youtube": (job, body) => {
    if (job.status !== "done") return "Video is not finished yet";
    if (!P.useKeys.getStore()?.owner) return "Only the studio's owner can upload to its YouTube channel";
    if (!job.publish) return "Make the publish pack first";
    const problem = Y.notReady();
    if (problem) return problem;
    if (body.publishAt !== undefined && !(typeof body.publishAt === "string" && Date.parse(body.publishAt) > Date.now())) return "The release time must be in the future";
    job.youtubeAt = body.publishAt;
    run(job, ["youtube"], "done");
  },
  // body: { on } — show this finished story on the public intro, watch only (owner only; shown unless hidden)
  "intro": (job, body) => {
    if (!P.useKeys.getStore()?.owner) return "Only the studio's owner chooses what the intro shows";
    if (job.status !== "done") return "Only a finished video can be shown on the intro";
    if (typeof body.on !== "boolean") return "Say on or off";
    job.onIntro = body.on;
    save(job);
  },
  "retry": (job) => job.status !== "error" || !job.pending ? "Nothing to retry" : run(job, job.pending.steps, job.pending.after),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean);
  const json = (code, data) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
  if (!allowedHost(req.headers.host)) { res.writeHead(421, { "Content-Type": "text/plain" }); return res.end("Open the studio at localhost"); }
  // Online, every page gets these: no framing by other sites, no guessing file types, no full addresses
  // (a reset link's token) leaking to other sites.
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", CSP);
  // First visit: the intro, which is public. After it, the studio asks for the sign-in when a password is set.
  if (req.method === "GET" && url.pathname === "/" && showIntroFirst(url.search, req.headers.cookie, RUN)) { res.writeHead(302, { Location: "/intro" }); return res.end(); }
  const user = (() => { const u = users.find(cookieUser(req.headers.cookie)); return u?.status === "approved" && sessionUser(req.headers.cookie, sessionKey(u)) ? u : null; })();
  if (!user && !isOpen(req.method, url.pathname) && !(["GET", "HEAD"].includes(req.method) && showcaseMedia(url.pathname, load, ownerId()))) {
    // Pages go to the sign-in page and come back after it; everything else is refused.
    if (req.method === "GET" && parts[0] !== "api" && parts[0] !== "media") { res.writeHead(302, { Location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` }); return res.end(); }
    return json(401, { error: "Sign in to do this", signIn: true });
  }
  return P.useKeys.run({ owner: user?.role === "owner" }, () => route(req, res, url, parts, json, user));
});

// Through the tunnel the visitor's address comes from Cloudflare; on this Mac it is the socket's.
const visitor = (req) => (isLocal(req.headers.host) ? req.socket.remoteAddress : req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress);
// Over the tunnel the browser talks HTTPS, so the sign-in cookie is marked Secure (never sent over plain HTTP).
const secure = (req) => !isLocal(req.headers.host) && req.headers["x-forwarded-proto"] === "https";
const accountLimit = rateLimit(20, 15 * 60_000);
const actionLimit = rateLimit(120, 60_000); // per account; reads aren't limited, the page polls them

async function route(req, res, url, parts, json, user) {
  // Inside a request, only stories this account may see exist; anything else is "not found".
  // A visitor may still fetch the poster or final of a story the owner put on the intro.
  const introMedia = showcaseMedia(url.pathname, loadAny, ownerId());
  const load = (id) => { const j = loadAny(id); return j && (visibleTo(j, user) || (introMedia && j.id === parts[1])) ? j : null; };
  const allJobs = () => allJobsAny().filter((j) => visibleTo(j, user));
  const signIn = (u) => { res.setHeader("Set-Cookie", `dv_session=${sessionToken(sessionKey(u), u.id)}; Path=/; Max-Age=${SESSION_HOURS * 3600}; HttpOnly; SameSite=Lax${secure(req) ? "; Secure" : ""}`); };
  if (req.method === "POST" && ["/api/login", "/api/signup", "/api/forgot", "/api/reset"].includes(url.pathname) && !accountLimit(visitor(req)))
    return json(429, { error: "Too many tries from your connection. Wait 15 minutes and try again" });
  if (user && ["POST", "DELETE"].includes(req.method) && !actionLimit(user.id)) return json(429, { error: "Too many actions in a minute. Wait a moment and try again" });
  try {
    // The page is the built Vite app in web/dist (npm run build).
    if (req.method === "GET" && url.pathname === "/") return sendFile(res, path.join(P.ROOT, "web/dist/index.html"));
    // The tab icon (the D mark); browsers that still ask for /favicon.ico are sent to it.
    if (req.method === "GET" && url.pathname === "/favicon.svg") return sendFile(res, path.join(P.ROOT, "web/dist/favicon.svg"));
    if (req.method === "GET" && url.pathname === "/favicon.ico") { res.writeHead(301, { Location: "/favicon.svg" }); return res.end(); }
    // Sign-in and sign-up share one page. A wrong password waits a second, to slow guessing.
    if (req.method === "GET" && ["/login", "/signup", "/forgot", "/reset"].includes(url.pathname)) {
      if (user) { res.writeHead(302, { Location: safeNext(url.searchParams.get("next")) }); return res.end(); }
      return sendFile(res, path.join(P.ROOT, "web/dist/login.html"));
    }
    if (req.method === "POST" && url.pathname === "/api/signup") {
      const { email, password, next } = await body(req);
      const out = users.signUp(email, password);
      if (out.error) return json(400, { error: out.error });
      if (out.user.status !== "approved") return json(202, { pending: true });
      signIn(out.user);
      return json(201, { next: safeNext(next) });
    }
    if (req.method === "POST" && url.pathname === "/api/login") {
      const { email, password, next } = await body(req);
      const out = users.signIn(email, password);
      if (out.error) { await new Promise((r) => setTimeout(r, 1000)); return json(401, { error: out.error }); }
      signIn(out.user);
      return json(200, { next: safeNext(next) });
    }
    // Forgot password: the same answer whether or not the email has an account, so emails can't be discovered.
    if (req.method === "POST" && url.pathname === "/api/forgot") {
      const reset = users.startReset((await body(req)).email);
      if (reset) {
        const link = `${process.env.PUBLIC_URL?.replace(/\/$/, "") || `${secure(req) ? "https" : "http"}://${req.headers.host}`}/reset?token=${reset.token}`;
        await sendMail(reset.email, "Reset your Dashavani Studio password",
          `Someone asked to reset the password for this Dashavani Studio account.\n\nSet a new password here (the link works once, for one hour):\n${link}\n\nIf it wasn't you, ignore this email; your password stays the same.`)
          .catch((e) => console.error("Reset email failed:", e.message));
      }
      return json(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/reset") {
      const { token, password } = await body(req);
      const out = users.finishReset(token, password);
      if (out.error) return json(400, { error: out.error });
      if (out.user.status === "approved") signIn(out.user);
      return json(200, { next: out.user.status === "approved" ? "/" : null });
    }
    if (req.method === "POST" && url.pathname === "/api/logout") {
      if (user) users.endSessions(user.id); // signs this account out everywhere
      res.setHeader("Set-Cookie", "dv_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
      return json(200, { ok: true });
    }
    // A temporary password from the owner must be changed before anything else.
    if (user?.mustChange && parts[0] === "api" && !["/api/me", "/api/me/password", "/api/stats", "/api/showcase", "/api/logout"].includes(url.pathname))
      return json(403, { error: "Change your temporary password first (Account)", mustChange: true });
    // body: { current, password }. The new sign-in replaces the old one, which the new password ends.
    if (req.method === "POST" && url.pathname === "/api/me/password") {
      const { current, password } = await body(req);
      const out = users.changePassword(user.id, current, password);
      if (out.error) return json(400, { error: out.error });
      signIn(out.user);
      return json(200, { ok: true });
    }
    // The signed-in account: who it is and its role (API keys stay in .env.local and never reach the page).
    if (req.method === "GET" && url.pathname === "/api/me") return json(200, users.pub(user));
    // The owner approves or removes the accounts people sign up for.
    if (req.method === "GET" && url.pathname === "/api/users") return user.role === "owner" ? json(200, users.list()) : json(403, { error: "Only the owner manages accounts" });
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "users" && parts[3] === "status" && parts.length === 4) {
      if (user.role !== "owner") return json(403, { error: "Only the owner manages accounts" });
      const problem = users.setStatus(parts[2], (await body(req)).status);
      return problem ? json(409, { error: problem }) : json(200, users.list());
    }
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "users" && parts[3] === "password" && parts.length === 4) {
      if (user.role !== "owner") return json(403, { error: "Only the owner manages accounts" });
      const out = users.tempPassword(parts[2]);
      return out.error ? json(409, { error: out.error }) : json(200, out);
    }
    if (req.method === "GET" && url.pathname === "/api/showcase") return json(200, showcase(allJobsAny(), ownerId()));
    // The intro's two public numbers, and whether this browser is signed in.
    if (req.method === "GET" && url.pathname === "/api/stats") {
      const jobs = user ? allJobs() : allJobsAny(); // visitors get the studio's counts only, never the stories
      return json(200, { done: jobs.filter((j) => j.status === "done").length, drafted: jobs.filter((j) => j.draft || j.finals?.length).length, signIn: true, signedIn: !!user });
    }
    // The scroll-driven intro page and its film (web/public/intro, copied into web/dist by the build).
    if (req.method === "GET" && url.pathname === "/intro") {
      res.setHeader("Set-Cookie", `dv_intro=${RUN}; Path=/; SameSite=Lax; HttpOnly`);
      return sendFile(res, path.join(P.ROOT, "web/dist/intro.html"));
    }
    if (req.method === "GET" && parts[0] === "intro" && /^[\w-]+\.(mp4|jpg)$/.test(parts[1] ?? "") && parts.length === 2) return sendFile(res, path.join(P.ROOT, "web/dist/intro", parts[1]), req);
    if (req.method === "GET" && parts[0] === "assets" && /^[\w.-]+$/.test(parts[1] ?? "") && parts.length === 2) return sendFile(res, path.join(P.ROOT, "web/dist/assets", parts[1]));
    if (req.method === "GET" && parts[0] === "templates" && /^vt[\w-]+\.jpg$/.test(parts[1] ?? "")) return sendFile(res, path.join(P.ROOT, "public/templates", parts[1]));
    if (req.method === "GET" && parts[0] === "fonts" && /^[\w-]+\.(ttf|woff2)$/.test(parts[1] ?? "")) return sendFile(res, path.join(P.ROOT, "templates/vt01-lead-desk/assets/fonts", parts[1]));
    if (req.method === "GET" && parts[0] === "media" && parts[2] === "poster.jpg" && load(parts[1])) {
      const file = await P.poster(load(parts[1]));
      return file ? sendFile(res, file) : json(404, { error: "No video yet" });
    }
    if (req.method === "GET" && parts[0] === "media" && parts[2] === "thumbnail.jpg") {
      const job = load(parts[1]), file = job && await P.thumbnail(job);
      if (!file) return json(404, { error: "No video yet" });
      res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Disposition": `attachment; filename="${parts[1].slice(0, 8)}-thumbnail.jpg"` });
      return res.end(fs.readFileSync(file));
    }
    if (req.method === "GET" && parts[0] === "media" && load(parts[1]) && parts[2] === "photos" && /^[0-9a-f]{16}\.(jpg|png|webp|mp4)$/.test(parts[3] ?? "")) return sendFile(res, path.join(P.projectDir({ id: parts[1] }), "assets/photos", parts[3]), req);
    if (req.method === "GET" && parts[0] === "media" && load(parts[1]) && parts[2] === "subtitles" && /^[a-z]{2}\.(vtt|srt)$/.test(parts[3] ?? "")) {
      const file = path.join(P.projectDir({ id: parts[1] }), "subtitles", parts[3]);
      if (!fs.existsSync(file)) return json(404, { error: "No subtitles in that language" });
      res.writeHead(200, { "Content-Type": parts[3].endsWith(".vtt") ? "text/vtt; charset=utf-8" : "application/x-subrip; charset=utf-8", ...(parts[3].endsWith(".srt") && { "Content-Disposition": `attachment; filename="${parts[1].slice(0, 8)}-${parts[3]}"` }) });
      return res.end(fs.readFileSync(file));
    }
    if (req.method === "GET" && parts[0] === "media" && load(parts[1]) && parts[2] === "voice.wav") return sendFile(res, path.join(P.projectDir({ id: parts[1] }), "assets/voice.wav"), req);
    if (req.method === "GET" && parts[0] === "media" && parts[2] === "download" && /^final-v\d+\.mp4$/.test(parts[3] ?? "")) {
      const job = load(parts[1]), q = url.searchParams.get("q") ?? "original", subs = url.searchParams.get("subs") ?? "all";
      if (!job?.finals?.includes(parts[3])) return json(404, { error: "No such version" });
      if (!Object.hasOwn(P.QUALITIES, q)) return json(400, { error: "Unknown quality" });
      if (!["all", "none"].includes(subs) && !Object.hasOwn(P.LANGS, subs)) return json(400, { error: "Unknown subtitle choice" });
      const file = await P.download(job, parts[3], q, subs);
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": fs.statSync(file).size, "Content-Disposition": `attachment; filename="dashavani-${parts[1].slice(0, 8)}-${parts[3].replace(".mp4", "")}-${q}-${subs}.mp4"` });
      return fs.createReadStream(file).pipe(res);
    }
    if (req.method === "GET" && parts[0] === "media" && load(parts[1]) && /^[\w-]+\.mp4$/.test(parts[2] ?? "")) return sendFile(res, path.join(P.projectDir({ id: parts[1] }), "renders", parts[2]), req);

    // Verified inbox (PIB today; more sources in sources.mjs). A person picks one; nothing becomes a video automatically.
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "inbox" && parts.length === 2) {
      const lang = url.searchParams.get("lang");
      const want = Object.hasOwn(P.LANGS, lang ?? "") ? lang : "en";
      // Translating costs the owner's Gemini money, so only signed-in visits ask for it; others get what is cached.
      const out = await inbox(want, { cache: wireCache, translate: user ? translateLater : () => Promise.resolve(null) });
      return json(200, { ...out, translating: !!wireBusy[want] });
    }
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "inbox" && parts.length === 4) {
      const src = SOURCES[parts[2]];
      if (!src || !src.idPattern.test(parts[3])) return json(404, { error: "Unknown story source." });
      const lang = url.searchParams.get("lang");
      // The source's own words when it fails ("PIB release 123: 404"): they say what went wrong and hold nothing private.
      const item = await src.item(parts[3], Object.hasOwn(P.LANGS, lang) ? lang : "en").catch((e) => { throw Object.assign(e, { status: 502 }); });
      return json(200, { ...item, source: parts[2], sourceName: src.name, sourceFullName: src.fullName, url: src.url(parts[3]) });
    }
    // Usage and prices: voice characters left, and what this month's stories cost by part.
    // Template designer: new looks described in words, as drafts until approved.
    if (req.method === "GET" && url.pathname === "/api/templates") return json(200, D.listTemplates());
    if (req.method === "POST" && url.pathname === "/api/templates") {
      const { base, request } = await body(req);
      if (!Object.hasOwn(P.TEMPLATES, base) && !P.isApprovedCustom(base)) return json(400, { error: "Pick a template to start from." });
      if (typeof request !== "string" || request.trim().length < 5 || request.length > 500) return json(400, { error: "Describe the look in 5 to 500 characters." });
      return json(201, D.startDesign(base, request.trim()));
    }
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "templates" && parts[3] === "status") {
      if (user.role !== "owner") return json(403, { error: "Only the owner approves or rejects looks" });
      const problem = D.setStatus(parts[2], (await body(req)).status);
      return problem ? json(409, { error: problem }) : json(200, D.listTemplates());
    }
    if (req.method === "GET" && parts[0] === "templates" && /^c-[a-f0-9]{8}\.jpg$/.test(parts[1] ?? "")) return sendFile(res, path.join(D.CUSTOM, parts[1].replace(".jpg", ""), "preview.jpg"));
    if (req.method === "GET" && url.pathname === "/api/bulletins") {
      return json(200, fs.readdirSync(BULLETINS).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(BULLETINS, f), "utf8"))).filter((b) => visibleTo(b, user)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    }
    // body: { title, stories: [job ids in order] } — at least two stories with a video, all in the same format
    if (req.method === "POST" && url.pathname === "/api/bulletins") {
      const { title = "", stories } = await body(req);
      if (!Array.isArray(stories) || stories.length < 2 || stories.length > 12 || new Set(stories).size !== stories.length) return json(400, { error: "Pick between 2 and 12 different stories." });
      const jobs = stories.map(load);
      if (jobs.some((j) => !j || !(j.draft || j.finals?.length))) return json(400, { error: "Every story needs a draft or final video first." });
      if (new Set(jobs.map((j) => j.format ?? "landscape")).size > 1) return json(400, { error: "A bulletin is all landscape or all Shorts & Reels." });
      if (typeof title !== "string" || title.length > 90) return json(400, { error: "Title must be at most 90 characters." });
      const b = { id: `b-${randomUUID()}`, createdBy: user.id, title: title.trim() || `Bulletin ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`, stories, format: jobs[0].format ?? "landscape",
        langs: [...new Set(jobs.map((j) => j.lang))], headlines: jobs.map((j) => j.script?.headline ?? ""), status: "queued", createdAt: new Date().toISOString() };
      buildBulletin(b);
      return json(201, b);
    }
    if (req.method === "GET" && parts[0] === "media" && parts[1] === "bulletins" && visibleTo(loadBulletin((parts[2] ?? "").replace(/\.mp4$/, "")), user)) return sendFile(res, path.join(BULLETINS, parts[2]), req);
    if (req.method === "GET" && url.pathname === "/api/usage") {
      const all = allJobs();
      return json(200, { voice: await voiceCredits(process.env.ELEVENLABS_API_KEY, user.role === "owner" ? null : new Set(all.map((j) => j.id))), month: P.monthSpend(all), rates: P.RATES,
        ...(user.role === "owner" && { accounts: P.spendByAccount(all, user.id).map((a) => ({ ...a, email: users.find(a.id)?.email ?? "removed account" })) }) });
    }
    if (parts[0] !== "api" || parts[1] !== "jobs") return json(404, { error: "Not found" });
    if (req.method === "GET" && parts.length === 2) {
      const all = allJobs();
      return json(200, all.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((j) => ({ ...j, review: P.reviewReasons(j).length > 0, hasVideo: !!(j.draft || j.finals?.length) })).map(({ id, status, lang, format, presenter, script, createdAt, review, hasVideo, group, source }) => ({ id, status, lang, format, presenter, review, hasVideo, headline: script?.headline, category: script?.category, template: script?.template, createdAt, group, sourceTitle: source?.title, sourceName: source?.name })));
    }
    if (req.method === "POST" && parts.length === 2) {
      const { input, lang, brief = "", source, format = "landscape", bothFormats = false, presenter = true, twinPresenter, group } = await body(req);
      if (typeof input !== "string" || input.trim().length < 20) return json(400, { error: "Paste the news item (at least 20 characters)." });
      if (input.length > 20000) return json(400, { error: "News text is too long (20,000 characters max)." });
      if (!Object.hasOwn(P.LANGS, lang)) return json(400, { error: "Unsupported language." });
      if (!Object.hasOwn(P.FORMATS, format)) return json(400, { error: "Unsupported format." });
      if (typeof presenter !== "boolean") return json(400, { error: "Presenter must be on or off." });
      if (typeof bothFormats !== "boolean") return json(400, { error: "bothFormats must be true or false." });
      if (twinPresenter !== undefined && typeof twinPresenter !== "boolean") return json(400, { error: "twinPresenter must be true or false." });
      if (group !== undefined && !/^[0-9a-f-]{36}$/.test(group)) return json(400, { error: "Bad language group." });
      if (typeof brief !== "string" || brief.length > 500) return json(400, { error: "Brief is too long (500 characters max)." });
      const jobSource = source === undefined ? undefined : validSource(source);
      if (source !== undefined && !jobSource) return json(400, { error: "Unknown story source." });
      const capped = overCap(allJobs(), user, { daily: Number(process.env.DAILY_STORIES) || 20, monthCap: Number(process.env.MONTHLY_CAP_INR) || 0, spent: P.monthSpend(allJobsAny()).total });
      if (capped) return json(429, { error: capped });
      const job = { id: randomUUID(), createdBy: user.id, input: input.trim(), lang, format, presenter, ...(bothFormats && { bothFormats, ...(twinPresenter !== undefined && { twinPresenter }) }), brief: brief.trim(), createdAt: new Date().toISOString(), ...(group && { group }),
        ...(jobSource && { source: jobSource }) };
      run(job, ["script"], "script_review");
      return json(201, job);
    }
    const job = load(parts[2]);
    if (!job) return json(404, { error: "Job not found" });
    if (req.method === "GET" && parts.length === 3) {
      // The same story in its other languages (filed together, linked by group).
      const siblings = job.group ? allJobs().filter((o) => o.group === job.group && o.id !== job.id).map(({ id, lang, status, format }) => ({ id, lang, status, format: format ?? "landscape" })) : [];
      return json(200, { ...job, ...(job.status === "queued" && queue.ahead(job.id) > 0 && { ahead: queue.ahead(job.id) }), ...(job.status === "script" && P.writing.has(job.id) && { writing: P.writing.get(job.id) }), back: P.backTargets(job), siblings, review: P.reviewReasons(job), timeline: P.timelineFor(job), ...(job.status === "script_review" && job.script && { scriptProblems: [...P.scriptProblems(P.dropUnused(job.script)), ...P.scriptMismatches(P.dropUnused(job.script), job.lang)] }) });
    }
    // Photos can change while the script is under review; the cutaways are built when the draft is made.
    // English meaning of the script as it stands in the review form (not saved as the script).
    if (req.method === "POST" && parts[3] === "english") {
      if (job.status !== "script_review") return json(409, { error: "The script is not under review" });
      let english;
      try { english = await P.backTranslate(job, (await body(req)).script); }
      catch (e) { return json(e.status ?? 502, { error: e.message }); }
      // The check takes seconds; if the script was approved meanwhile, keep the approval and only add the cost.
      const now = load(job.id);
      Object.assign(now, { cost: job.cost, ...(now.status === "script_review" && { english: job.english }) });
      save(now);
      return json(200, { english });
    }
    if (parts[3] === "photos" && (req.method === "POST" || req.method === "DELETE")) {
      if (job.status !== "script_review") return json(409, { error: "Photos can be changed while the script is under review" });
      if (req.method === "POST") {
        const type = req.headers["content-type"]?.split(";")[0];
        const before = new Set((job.photos ?? []).map((p) => p.file));
        try { await P.savePhoto(job, await bytes(req, Object.hasOwn(P.CLIP_TYPES, type) ? P.MAX_CLIP_BYTES : P.MAX_PHOTO_BYTES), type, "Uploaded"); }
        catch (e) { return json(400, { error: e.message }); }
        // A big clip takes a while: add it to the job as it is now, unless the script was approved meanwhile.
        const added = (job.photos ?? []).filter((p) => !before.has(p.file)), now = load(job.id);
        if (now.status !== "script_review") {
          for (const p of added) for (const f of [p.file, p.poster].filter(Boolean)) fs.rmSync(path.join(P.projectDir(job), "assets/photos", f), { force: true });
          return json(409, { error: "The script was approved while this uploaded; the draft is made without it" });
        }
        now.photos = [...(now.photos ?? []), ...added];
        save(now);
        return json(200, now);
      } else {
        const keep = (job.photos ?? []).filter((p) => p.file !== parts[4]);
        if (keep.length === (job.photos ?? []).length) return json(404, { error: "No such photo" });
        const gone = (job.photos ?? []).find((p) => p.file === parts[4]);
        for (const f of [gone.file, gone.poster].filter(Boolean)) fs.rmSync(path.join(P.projectDir(job), "assets/photos", f), { force: true });
        job.photos = keep;
      }
      save(job);
      return json(200, job);
    }
    if (req.method === "POST" && parts[3] === "studio") {
      // HyperFrames Studio runs on this Mac (port 3002), which visitors over the internet can't reach.
      if (user.role !== "owner" || !isLocal(req.headers.host)) return json(403, { error: "Studio editing works only for the owner, on the studio's own computer" });
      if (!fs.existsSync(path.join(P.projectDir(job), "index.html"))) return json(409, { error: "The video project does not exist yet." });
      return json(200, { url: await P.openStudio(job) });
    }
    if (req.method === "POST" && ACTIONS[parts[3]]) {
      // Read the body first, then the job: a double click's second request must see the first one's new status.
      const payload = await body(req), now = load(job.id);
      const problem = ACTIONS[parts[3]](now, payload);
      return problem ? json(409, { error: problem }) : json(200, now);
    }
    json(404, { error: "Not found" });
  } catch (e) {
    if (!e.status) console.error(e);
    if (res.headersSent) return res.destroy(); // a stream already started: a second writeHead would crash the server
    json(e.status ?? 500, e.status ? { error: e.message } : { error: "Something went wrong; try again" }); // the details (paths, tool output) stay in the log
  }
}

// Raw request body as bytes, refused past max.
async function bytes(req, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    if ((size += chunk.length) > max) throw new Error(`File is larger than ${max >> 20} MB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Only application/json is read: a form on another site can post text/plain without asking, never JSON.
async function body(req) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw Object.assign(new Error("Send JSON"), { status: 415 });
  let raw = "";
  for await (const chunk of req) if ((raw += chunk).length > 1e6) throw Object.assign(new Error("Request too large"), { status: 413 });
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error("That is not valid JSON"), { status: 400 }); }
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
}

// Range support so the <video> element can seek.
function sendFile(res, file, req) {
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  const type = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".ttf": "font/ttf", ".mp4": "video/mp4", ".wav": "audio/wav", ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2" }[path.extname(file)];
  const size = fs.statSync(file).size;
  const range = parseRange(req?.headers.range, size);
  if (range === "bad") { res.writeHead(416, { "Content-Range": `bytes */${size}` }); return res.end(); }
  if (range) {
    const { start, end } = range;
    res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
  fs.createReadStream(file).pipe(res);
}

// Jobs interrupted by a restart become retryable instead of stuck.
for (const job of allJobs()) {
  if (job.pending && job.status !== "error") save({ ...job, status: "error", error: `${job.status}: interrupted by a server restart` });
}
for (const f of fs.readdirSync(BULLETINS).filter((f) => f.endsWith(".json"))) {
  const b = JSON.parse(fs.readFileSync(path.join(BULLETINS, f), "utf8"));
  if (["queued", "making"].includes(b.status)) saveBulletin({ ...b, status: "error", error: "Interrupted by a server restart; make it again" });
}

// .env.local holds the owner's keys: other users of this Mac shouldn't be able to read it.
if (fs.existsSync(path.join(P.ROOT, ".env.local")) && fs.statSync(path.join(P.ROOT, ".env.local")).mode & 0o077) console.warn("Warning: .env.local can be read by other users of this Mac. Run: chmod 600 .env.local");
server.listen(PORT, "127.0.0.1", () => console.log(`Dashavani Studio on http://localhost:${PORT}${P.MOCK ? "  (MOCK mode: no API calls)" : ""}`));
