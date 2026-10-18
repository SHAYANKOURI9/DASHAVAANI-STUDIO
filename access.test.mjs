// Every route, asked by the owner, two editors and a visitor who isn't signed in, against the real server (mock mode,
// its own temp data folder). A new route in server.mjs with no row here fails the last test.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "dv-access-"));
const PORT = 4300 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
let server, out = "";

// A browser: keeps its own sign-in cookie.
const browser = () => {
  const b = { cookie: "" };
  b.req = async (method, url, data, headers = {}) => {
    const res = await fetch(BASE + url, { method, redirect: "manual", headers: { ...(b.cookie && { cookie: b.cookie }), ...(data !== undefined && { "Content-Type": "application/json" }), ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
    const set = res.headers.getSetCookie().find((c) => c.startsWith("dv_session="));
    if (set) b.cookie = set.split(";")[0];
    b.last = set;
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  };
  return b;
};
const owner = browser(), a = browser(), b = browser(), anon = browser();
const ids = {};

// A finished story for an account, with every file its routes serve already in place (no rendering needed).
function seedStory(createdBy) {
  const id = randomUUID(), dir = path.join(DATA, "projects", id);
  for (const d of ["renders", "subtitles", "assets/photos"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  for (const f of ["renders/final-v1.mp4", "renders/poster-final-v1.jpg", "renders/thumb-final-v1.jpg", "subtitles/en.vtt", "subtitles/en.srt", "assets/voice.wav", "assets/photos/0123456789abcdef.jpg"]) fs.writeFileSync(path.join(dir, f), "x");
  fs.writeFileSync(path.join(DATA, "jobs", `${id}.json`), JSON.stringify({ id, createdBy, status: "done", lang: "en", format: "landscape", presenter: false, onIntro: false, input: "x".repeat(30), script: { headline: "H", narration: "N" }, finals: ["final-v1.mp4"], photos: [{ file: "0123456789abcdef.jpg", from: "Uploaded" }], createdAt: new Date().toISOString() }));
  return id;
}
function seedBulletin(createdBy) {
  const id = `b-${randomUUID()}`;
  fs.writeFileSync(path.join(DATA, "bulletins", `${id}.json`), JSON.stringify({ id, createdBy, title: "B", stories: [], status: "done", file: `${id}.mp4`, createdAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(DATA, "bulletins", `${id}.mp4`), "x");
  return id;
}

before(async () => {
  server = spawn(process.execPath, ["server.mjs", "--mock"], { env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), SMTP_HOST: "", MONTHLY_CAP_INR: "100", MOCK_TYPE_MS: "60" }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => (out += d));
  server.stderr.on("data", (d) => (out += d));
  await new Promise((ok, no) => { const t = setInterval(() => { if (out.includes("Dashavani Studio on")) { clearInterval(t); ok(); } }, 50); setTimeout(() => no(new Error(`server did not start:\n${out}`)), 15000); });
  assert.equal((await owner.req("POST", "/api/signup", { email: "o@x.com", password: "ownerpass1" })).status, 201);
  for (const [who, email] of [[a, "a@x.com"], [b, "b@x.com"]]) assert.equal((await who.req("POST", "/api/signup", { email, password: "editorpass1" })).status, 202);
  for (const u of (await owner.req("GET", "/api/users")).body.filter((u) => u.role !== "owner")) await owner.req("POST", `/api/users/${u.id}/status`, { status: "approved" });
  for (const [who, email] of [[a, "a@x.com"], [b, "b@x.com"]]) assert.equal((await who.req("POST", "/api/login", { email, password: "editorpass1" })).status, 200);
  ids.owner = (await owner.req("GET", "/api/me")).body.id; ids.a = (await a.req("GET", "/api/me")).body.id;
  Object.assign(ids, { storyA: seedStory(ids.a), storyO: seedStory(ids.owner), bulletinA: seedBulletin(ids.a) });
});
after(() => { server?.kill(); fs.rmSync(DATA, { recursive: true, force: true }); });

// Everything that belongs to editor A's story and bulletin.
const aRoutes = () => {
  const s = ids.storyA, j = `/api/jobs/${s}`;
  return [
    ["GET", j], ["GET", `/media/${s}/poster.jpg`], ["GET", `/media/${s}/thumbnail.jpg`], ["GET", `/media/${s}/photos/0123456789abcdef.jpg`],
    ["GET", `/media/${s}/subtitles/en.vtt`], ["GET", `/media/${s}/voice.wav`], ["GET", `/media/${s}/download/final-v1.mp4`], ["GET", `/media/${s}/final-v1.mp4`],
    ["GET", `/media/bulletins/${ids.bulletinA}.mp4`],
  ];
};
const ACTIONS = [...fs.readFileSync("server.mjs", "utf8").matchAll(/^ {2}"?([a-z-]+)"?: (?:\(job|async \(job)/gm)].map((m) => m[1]);
const aActions = () => [...ACTIONS.map((x) => ["POST", `/api/jobs/${ids.storyA}/${x}`, {}]), ["POST", `/api/jobs/${ids.storyA}/english`, {}], ["POST", `/api/jobs/${ids.storyA}/photos`, {}], ["DELETE", `/api/jobs/${ids.storyA}/photos/0123456789abcdef.jpg`], ["POST", `/api/jobs/${ids.storyA}/studio`, {}]];

test("an editor's own story and its files open for that editor and the owner", async () => {
  for (const [m, u] of aRoutes()) {
    assert.equal((await a.req(m, u)).status, 200, `editor A: ${u}`);
    assert.equal((await owner.req(m, u)).status, 200, `owner: ${u}`);
  }
});

test("another editor gets 'not found' for every part of it, including every action", async () => {
  for (const [m, u, d] of [...aRoutes(), ...aActions(), ["GET", `/api/jobs/${ids.storyO}`], ["GET", `/media/${ids.storyO}/final-v1.mp4`]]) assert.equal((await b.req(m, u, d)).status, 404, `editor B: ${m} ${u}`);
  const list = (await b.req("GET", "/api/jobs")).body;
  assert.deepEqual(list, [], "B's list has nobody else's stories");
  assert.deepEqual((await b.req("GET", "/api/bulletins")).body, []);
  assert.equal((await b.req("POST", "/api/bulletins", { stories: [ids.storyA, ids.storyO] })).status, 400, "nor can B put them in a bulletin");
});

test("a visitor who isn't signed in gets nothing but the open pages", async () => {
  for (const [m, u, d] of [...aRoutes(), ...aActions(), ["GET", "/api/jobs"], ["POST", "/api/jobs", {}], ["GET", "/api/me"], ["POST", "/api/me/keys", {}], ["POST", "/api/me/password", {}], ["GET", "/api/users"],
    ["GET", "/api/usage"], ["GET", "/api/bulletins"], ["POST", "/api/bulletins", {}], ["GET", "/api/templates"], ["POST", "/api/templates", {}], ["POST", "/api/templates/c-12345678/status", {}],
    ["GET", "/api/inbox/pib/1"], ["POST", `/api/users/${ids.a}/status`, {}], ["POST", `/api/users/${ids.a}/password`, {}], ["GET", `/media/${ids.storyO}/final-v1.mp4`], ["GET", `/media/${ids.storyO}/poster.jpg`]])
    assert.equal((await anon.req(m, u, d)).status, 401, `visitor: ${m} ${u}`);
  for (const u of ["/?job=1", "/?view=bulletins", "/templates/c-12345678.jpg"]) assert.equal((await anon.req("GET", u)).status, 302, `page ${u} goes to sign-in`);
  for (const u of ["/intro", "/login", "/signup", "/forgot", "/reset", "/favicon.svg", "/api/stats", "/api/showcase", "/api/inbox", "/intro/film.mp4", "/assets/none.js", "/fonts/none.ttf", "/templates/vt01-lead-desk.jpg"]) assert.notEqual((await anon.req("GET", u)).status, 401, `open: ${u}`);
  assert.equal((await anon.req("GET", "/favicon.ico")).status, 301);
  assert.deepEqual((await anon.req("GET", "/api/showcase")).body, [], "a hidden video is not on the intro");
});

test("admin actions are the owner's", async () => {
  for (const [m, u, d] of [["GET", "/api/users"], ["POST", `/api/users/${ids.a}/status`, { status: "removed" }], ["POST", `/api/users/${ids.owner}/password`, {}], ["POST", "/api/templates/c-12345678/status", { status: "approved" }]])
    assert.equal((await a.req(m, u, d)).status, 403, `editor: ${m} ${u}`);
  assert.equal((await a.req("POST", "/api/me/keys", { GEMINI_API_KEY: "k" })).status, 404, "nobody gives the app an API key");
  assert.equal((await a.req("POST", `/api/jobs/${ids.storyA}/studio`, {})).status, 403, "Studio is the owner's");
  assert.equal("accounts" in (await a.req("GET", "/api/usage")).body, false, "only the owner sees the spend per account");
  assert.equal("keys" in (await a.req("GET", "/api/me")).body, false);
});

test("sign-in, sign-out everywhere, change and reset of a password", async () => {
  const phone = browser(), laptop = browser();
  assert.equal((await phone.req("POST", "/api/login", { email: "b@x.com", password: "wrong-pass" })).status, 401);
  assert.equal((await phone.req("POST", "/api/login", { email: "b@x.com", password: "editorpass1" })).status, 200);
  assert.match(phone.last, /HttpOnly/); assert.match(phone.last, /SameSite=Lax/); assert.doesNotMatch(phone.last, /Secure/, "plain http on this Mac");
  await laptop.req("POST", "/api/login", { email: "b@x.com", password: "editorpass1" });
  const copied = phone.cookie;
  assert.equal((await phone.req("POST", "/api/logout", {})).status, 200);
  assert.equal((await laptop.req("GET", "/api/jobs")).status, 401, "signing out ends the account's other sign-ins too");
  assert.equal((await fetch(`${BASE}/api/jobs`, { headers: { cookie: copied } })).status, 401, "and a copied cookie");

  // Change password: the new sign-in works, the old password doesn't.
  await phone.req("POST", "/api/login", { email: "b@x.com", password: "editorpass1" });
  assert.equal((await phone.req("POST", "/api/me/password", { current: "nope-nope", password: "editorpass2" })).status, 400);
  assert.equal((await phone.req("POST", "/api/me/password", { current: "editorpass1", password: "editorpass2" })).status, 200);
  assert.equal((await phone.req("GET", "/api/jobs")).status, 200, "still signed in on this browser");

  // Forgot password: the link (printed, as mail isn't set up) works once and ends the older sign-in.
  out = "";
  assert.equal((await anon.req("POST", "/api/forgot", { email: "b@x.com" })).status, 200);
  assert.equal((await anon.req("POST", "/api/forgot", { email: "nobody@x.com" })).status, 200, "the same answer for an unknown email");
  await new Promise((r) => setTimeout(r, 200));
  const token = /reset\?token=([\w-]+)/.exec(out)?.[1];
  assert.ok(token, "the reset link was printed");
  const reset = browser();
  assert.equal((await reset.req("POST", "/api/reset", { token, password: "editorpass3" })).status, 200);
  assert.equal((await reset.req("POST", "/api/reset", { token, password: "editorpass4" })).status, 400, "the link works once");
  assert.equal((await phone.req("GET", "/api/jobs")).status, 401, "the reset ended the older sign-in");
  assert.equal((await reset.req("GET", "/api/jobs")).status, 200);

  // The owner's temporary password: nothing else works until it's changed.
  const { password } = (await owner.req("POST", `/api/users/${(await reset.req("GET", "/api/me")).body.id}/password`, {})).body;
  const temp = browser();
  assert.equal((await temp.req("POST", "/api/login", { email: "b@x.com", password })).status, 200);
  assert.equal((await temp.req("GET", "/api/jobs")).status, 403);
  assert.equal((await temp.req("GET", "/api/me")).body.mustChange, true);
  assert.equal((await temp.req("POST", "/api/me/password", { current: password, password: "editorpass1" })).status, 200);
  assert.equal((await temp.req("GET", "/api/jobs")).status, 200);
  Object.assign(b, { cookie: temp.cookie });
});

test("while the script is being written, the story shows it growing; afterwards nothing extra is kept", async () => {
  const id = (await owner.req("POST", "/api/jobs", { input: "One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen.", lang: "en" })).body.id;
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const j = (await owner.req("GET", `/api/jobs/${id}`)).body;
    if (j.writing) seen.add(j.writing.narration);
    if (j.status === "script_review") { assert.equal("writing" in j, false); break; }
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(seen.size >= 2, `the narration grew in steps (saw ${seen.size})`);
  assert.ok([...seen].every((n) => "One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen.".startsWith(n)));
  assert.equal(JSON.parse(fs.readFileSync(path.join(DATA, "jobs", `${id}.json`), "utf8")).writing, undefined, "never saved");
});

test("at draft review: on-screen text and cutaways change without a new voice", async () => {
  // Stories waiting at draft review (the redraw they queue runs in the background; only what's queued is checked).
  const atDraft = () => {
    const id = seedStory(ids.a), f = path.join(DATA, "jobs", `${id}.json`);
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), status: "draft_review", draft: "draft-v1.mp4", seconds: 30, script: { template: "lead", category: "NEWS", headline: "Old", standfirst: "", dateline_city: "", narration: "Spoken words.", ticker: ["one"] }, photos: [{ file: "0123456789abcdef.jpg", from: "Uploaded" }] }));
    return id;
  };
  let id = atDraft();
  const act = (name, body, who = a) => who.req("POST", `/api/jobs/${id}/${name}`, body);
  assert.equal((await act("adjust", { script: { headline: "" } })).status, 409, "a headline can't be empty");
  assert.equal((await act("adjust", { script: { narration: "New words" } })).status, 409, "the spoken words need a new voice: not here");
  assert.equal((await act("adjust", { script: { headline: "Old" } })).status, 409, "nothing changed");
  assert.equal((await act("adjust", { at: { "nope.jpg": 3 } })).status, 409, "only this story's own photos");
  assert.equal((await act("adjust", { at: { "0123456789abcdef.jpg": -1 } })).status, 409);
  assert.equal((await act("adjust", { script: { headline: "New headline" } }, b)).status, 404, "another editor can't");
  const r = await act("adjust", { script: { headline: "New headline", ticker: ["one", "two"] }, off: ["0123456789abcdef.jpg"] });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.script.headline, r.body.script.ticker, r.body.script.narration], ["New headline", ["one", "two"], "Spoken words."]);
  assert.deepEqual(r.body.cutawayOff, ["0123456789abcdef.jpg"], "text and cutaways in one go: one redraw");
  assert.deepEqual(r.body.pending.steps, ["compose", "draft"], "only the page and draft are made again; no paid step");
  id = atDraft();
  const c = await act("adjust", { at: { "0123456789abcdef.jpg": 6 } });
  assert.equal(c.status, 200);
  assert.deepEqual([c.body.cutawayAt, c.body.cutawayOff], [{ "0123456789abcdef.jpg": 6 }, []]);
  assert.deepEqual(c.body.pending.steps, ["compose", "draft"]);
});

test("Studio edits: rendered as their own version from the edited page, kept with it, and brought back by Use this version", async () => {
  // Only the pages are checked here; the render itself needs HyperFrames' browser (checked by hand on a real draft).
  const id = seedStory(ids.owner), f = path.join(DATA, "jobs", `${id}.json`), dir = path.join(DATA, "projects", id);
  const job = (patch) => fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), ...patch }));
  const page = () => fs.readFileSync(path.join(dir, "index.html"), "utf8");
  const settle = async () => { for (let i = 0; i < 600; i++) { const j = (await owner.req("GET", `/api/jobs/${id}`)).body; if (!["queued", "voice", "compose", "draft"].includes(j.status)) return j; await new Promise((r) => setTimeout(r, 100)); } };
  const script = { template: "lead", category: "NEWS", headline: "H", standfirst: "", dateline_city: "", narration: "Spoken words.", ticker: [] };
  job({ status: "draft_review", draft: "draft-v1.mp4", seconds: 4, script, versions: [{ n: 1, at: new Date().toISOString(), draft: "draft-v1.mp4", script, note: "First draft from the approved script", spent: 0, voice: "reused" }] });
  fs.writeFileSync(path.join(dir, "index.html"), "<!-- edited in Studio -->");
  assert.equal((await a.req("POST", `/api/jobs/${id}/studio-render`, {})).status, 404, "another account can't");
  const r = await owner.req("POST", `/api/jobs/${id}/studio-render`, {});
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.pending.steps, r.body.changeNote], [["draft"], "Studio edits"], "only a render: the edited page is not rebuilt");
  await settle();
  assert.equal(fs.readFileSync(path.join(dir, "versions", "v2.html"), "utf8"), "<!-- edited in Studio -->", "version 2 keeps the page it was rendered from");
  // A later change rebuilds the page from the script; version 2's Studio edits stay with it and come back.
  fs.writeFileSync(path.join(dir, "index.html"), "<!-- rebuilt from the script -->");
  job({ status: "draft_review", versions: [...JSON.parse(fs.readFileSync(f, "utf8")).versions, { n: 2, at: new Date().toISOString(), draft: "draft-v2.mp4", script, note: "Studio edits", spent: 0, voice: "reused" }] });
  const back = await owner.req("POST", `/api/jobs/${id}/restore`, { n: 2 });
  assert.equal(back.status, 200);
  assert.deepEqual(back.body.pending.steps, ["voice", "compose", "draft"]);
  await settle();
  assert.equal(page(), "<!-- edited in Studio -->", "Use this version brings the Studio edits back");
  job({ status: "draft_review" });
  fs.rmSync(path.join(dir, "versions", "v2.html"));
  fs.writeFileSync(path.join(dir, "index.html"), "<!-- something else -->");
  await owner.req("POST", `/api/jobs/${id}/restore`, { n: 2 });
  await settle();
  assert.notEqual(page(), "<!-- something else -->", "a version from before pages were kept is rebuilt from its script");
});

test("an unexpected error says so plainly, without file paths or tool output", async () => {
  const r = await a.req("GET", `/media/${ids.storyA}/download/final-v1.mp4?q=720`); // the "video" is not a video: ffmpeg fails
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, { error: "Something went wrong; try again" });
});

test("an editor files at most 20 stories a day; another account is not held up", async () => {
  const story = { input: "The state government announced a new irrigation scheme for farmers today.", lang: "en" };
  for (let i = 0; i < 20; i++) assert.equal((await b.req("POST", "/api/jobs", story)).status, 201, `story ${i + 1}`);
  const r = await b.req("POST", "/api/jobs", story);
  assert.equal(r.status, 429);
  assert.match(r.body.error, /20 stories a day/);
  assert.equal((await a.req("POST", "/api/jobs", story)).status, 201);
});

test("the monthly cap counts everyone's spending (all on the server's keys) and stops everyone", async () => {
  const story = { input: "The state government announced a new irrigation scheme for farmers today.", lang: "en" };
  const spend = (createdBy, inr) => { const id = seedStory(createdBy), f = path.join(DATA, "jobs", `${id}.json`); fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), cost: { script: { inr }, voice: { inr: 0 }, presenter: { inr: 0 } } })); };
  spend(ids.a, 60);
  assert.equal((await owner.req("POST", "/api/jobs", story)).status, 201, "₹60 of ₹100");
  spend(ids.owner, 40);
  for (const who of [owner, a]) {
    const r = await who.req("POST", "/api/jobs", story);
    assert.equal(r.status, 429);
    assert.match(r.body.error, /₹100/);
  }
});

test("signed-in actions are limited to 120 a minute per account", async () => {
  let last;
  for (let i = 0; i < 121; i++) last = await a.req("POST", "/api/me/password", {});
  assert.equal(last.status, 429, "the 121st in a minute");
  assert.equal((await a.req("GET", "/api/jobs")).status, 200, "reading is never limited (the page polls)");
  assert.equal((await owner.req("POST", "/api/me/password", {})).status, 400, "another account is unaffected");
});

test("every route in server.mjs is asked about above", () => {
  const src = fs.readFileSync("server.mjs", "utf8"), mine = fs.readFileSync("access.test.mjs", "utf8");
  const named = [...src.matchAll(/url\.pathname === "([^"]+)"|parts\[\d\] === "([^"]+)"/g)].map((m) => m[1] ?? m[2]);
  for (const n of new Set(named)) assert.ok(mine.includes(n), `no access check for "${n}"`);
  assert.ok(ACTIONS.length >= 10, `actions found: ${ACTIONS.join(", ")}`);
});

test("pages carry a Content-Security-Policy that allows the theme switch by its hash", async () => {
  const res = await fetch(`${BASE}/login`), csp = res.headers.get("content-security-policy");
  assert.match(csp, /script-src 'self' 'sha256-[\w+/=]+'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
});
