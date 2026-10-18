import { t, uiLang } from "./i18n.js";
import { withSignIn } from "./signin.js";
import { mountPress } from "./press.js";
import { buildWall } from "./wall.js";

// [label, statuses shown on this step, the review stop a person can go back to]
const RAIL = [[t("Script"), ["script", "script_review", "edit", "fixlang"], "script_review"], [t("Voice"), ["voice", "voice_review", "compose"], "voice_review"], [t("Draft"), ["draft", "draft_review"], "draft_review"], [t("Presenter"), ["avatar"]], [t("Final"), ["final", "publish", "youtube", "done"]]];
const BUSY = new Set(["queued", "edit", "fixlang", "script", "voice", "compose", "draft", "avatar", "final", "publish", "youtube"]);
const SAY = {
  queued: t("In the queue"), edit: t("Making your change"), fixlang: t("Fixing the language"), script: t("Writing the script"), script_review: t("Waiting for your review"), voice_review: t("Voice ready to check"), voice: t("Recording the voice"),
  compose: t("Setting the page"), draft: t("Rendering the draft"), draft_review: t("Draft ready for approval"), avatar: t("Filming the AI presenter"),
  final: t("Rendering the final video"), publish: t("Writing the publish pack"), youtube: t("Uploading to YouTube"), done: t("Final video ready"), error: t("Stopped"),
};
const LANG = { en: ["En", t("English")], te: ["తె", t("Telugu")], hi: ["हि", t("Hindi")], ta: ["த", t("Tamil")], kn: ["ಕ", t("Kannada")], ml: ["മ", t("Malayalam")], mr: ["म", t("Marathi")], bn: ["বা", t("Bengali")], gu: ["ગુ", t("Gujarati")], or: ["ଓ", t("Odia")] };
const TPL = {
  lead: [t("Lead Desk"), "vt01-lead-desk", t("The presenter beside the headline.")],
  breaking: [t("Breaking"), "vt03-breaking", t("A red alert band for urgent, developing news.")],
  numbers: [t("Numbers Desk"), "vt04-numbers-desk", t("One key figure fills the screen.")],
  points: [t("Key Points"), "vt06-key-points", t("The ticker lines become numbered points, lit in turn.")],
  quote: [t("Quote"), "vt07-quote", t("Someone's exact words, with who said them.")],
  photo: [t("Photo Story"), "vt08-photo-story", t("The first photo fills the frame. Add a photo below.")],
};
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
let timer, press;
const canvas = document.createElement("canvas");
canvas.setAttribute("aria-hidden", "true");

$("#today").textContent = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" }).format(new Date());

// Scrolling past the hero locks the tower's rings into one column.
function onScroll() {
  if (!document.body.classList.contains("is-home")) return;
  press?.setScroll(scrollY / Math.max(1, $("#hero").offsetHeight * 0.8));
}
addEventListener("scroll", onScroll, { passive: true });

$("#hero-host").append(canvas);
mountPress(canvas).then((p) => { press = p; route(); }).catch(() => document.body.classList.add("flat"));

// Viewing is open to all; an action that needs signing in opens the sign-in panel and then carries on.
// The signed-in account (role decides owner-only controls such as the intro switch).
let me = null;
// HyperFrames Studio opens on this Mac only, so its button is for the owner working here.
const canStudio = () => me?.role === "owner" && ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
const meReady = fetch("/api/me").then((r) => (r.ok ? r.json() : null)).then((m) => { me = m; }).catch(() => {});

async function api(path, opts = {}) {
  const res = await withSignIn(() => fetch(path, { ...opts, headers: { "Content-Type": "application/json" } }));
  const data = await res.json().catch(() => ({}));
  // quiet: the editor chose "Not now" on the sign-in panel; nothing went wrong, so no message
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Request failed (${res.status})`), { quiet: res.status === 401 });
  return data;
}
const say = (err) => err.quiet || alert(t(err.message)); // quiet: "Not now" on the sign-in panel

// Verified inbox. "Use this story" loads the story (in the chosen language when the source has it).
let pendingSource = null;
// Theme switch. The new theme grows out of the switch as a circle where the browser supports view transitions.
const themeBtn = $("#theme");
function setTheme(light) {
  document.documentElement.dataset.theme = light ? "light" : "dark";
  themeBtn.setAttribute("aria-pressed", String(light));
  themeBtn.setAttribute("aria-label", light ? t("Switch to dark theme") : t("Switch to light theme"));
  try { localStorage.setItem("dv-theme", light ? "light" : "dark"); } catch {}
}
setTheme(document.documentElement.dataset.theme === "light");
themeBtn.addEventListener("click", () => {
  const light = document.documentElement.dataset.theme !== "light";
  if (!document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) return setTheme(light);
  const r = themeBtn.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
  const root = document.documentElement.style;
  root.setProperty("--tx", `${x}px`); root.setProperty("--ty", `${y}px`);
  root.setProperty("--tr", `${Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))}px`);
  document.startViewTransition(() => setTheme(light));
});

// Ticker: the verified stories, looped twice so the scroll has no seam; speed scales with length.
function fillTicker(titles) {
  $("#ticker").hidden = !titles.length;
  if (!titles.length) return;
  const run = titles.map((x) => `<span>${esc(x)}</span>`).join("");
  $("#ticker-run").innerHTML = run + run;
  $("#ticker-run").style.setProperty("--t", `${Math.max(40, titles.join("").length / 9)}s`);
}

// tries: while the server is still translating the wire into the interface language, ask again a few times.
async function loadInbox(tries = 6) {
  try {
    const { items, errors, translating } = await api(`/api/inbox?lang=${uiLang}`);
    if (translating && tries > 1) setTimeout(() => loadInbox(tries - 1), 8000);
    fillTicker(items.slice(0, 15).map((i) => i.title));
    const down = errors.map((e) => `<li class="muted">${t("Couldn't reach {source}: {message}.", { source: esc(e.source), message: esc(t(e.message)) })}</li>`).join("");
    $("#inbox-list").innerHTML = down + (items.slice(0, 15).map((i) => `<li><span class="t" translate="no">${esc(i.title)}</span>
      <span class="acts"><button type="button" data-source="${esc(i.source)}" data-id="${esc(i.id)}">${t("Use this story")}</button><a href="${esc(i.url)}" target="_blank" rel="noopener">${t("Original · {source}", { source: esc(i.sourceName) })}</a></span></li>`).join("")
      || `<li class="muted">${t("No stories right now. Check again later, or paste one below.")}</li>`);
  } catch (err) { $("#inbox-list").innerHTML = `<li class="muted">${t("Couldn't load the inbox: {error}. You can still paste a story below.", { error: esc(t(err.message)) })}</li>`; }
}
$("#inbox-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-id]");
  if (!btn) return;
  btn.disabled = true; btn.textContent = t("Loading…");
  try {
    const lang = document.querySelector('input[name="lang"]:checked')?.value ?? "en";
    const r = await api(`/api/inbox/${btn.dataset.source}/${btn.dataset.id}?lang=${lang}`);
    $("#input").value = `Source: ${r.sourceFullName} (${r.sourceName}), ${r.publisher}, ${r.date}\n\n${r.title}\n\n${r.body}`.slice(0, 20000);
    pendingSource = { source: r.source, id: r.id, title: r.title };
    const link = `<a href="${esc(r.url)}" target="_blank" rel="noopener">${t("Open original")}</a>`;
    $("#source-note").innerHTML = r.original
      ? t("From {source} story {id} (the {lang} version). Check it, then write the script. {link}", { source: esc(r.sourceName), id: esc(r.id), lang: LANG[lang]?.[1] ?? t("English"), link })
      : t("From {source} story {id}. Check it, then write the script. {link}", { source: esc(r.sourceName), id: esc(r.id), link });
    $("#source-note").hidden = false;
    $("#desk").scrollIntoView({ behavior: "smooth" });
    $("#brief").focus({ preventScroll: true });
  } catch (err) { say(err); }
  btn.disabled = false; btn.textContent = t("Use this story");
});
$("#input").addEventListener("input", () => { if (!$("#input").value.trim()) { pendingSource = null; $("#source-note").hidden = true; } });

// Both formats ticked: Shorts & Reels gets its own presenter choice. Only on a single format, the main choice is that format's.
$("#new").addEventListener("change", (e) => {
  if (e.target.name === "format") $("#pres2-wrap").hidden = document.querySelectorAll('input[name="format"]:checked').length < 2;
});
$("#new").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.submitter; btn.disabled = true; $("#new-err").hidden = true;
  try {
    const langs = [...document.querySelectorAll('input[name="lang"]:checked')].map((i) => i.value);
    if (!langs.length) throw new Error(t("Pick at least one language."));
    const formats = [...document.querySelectorAll('input[name="format"]:checked')].map((i) => i.value);
    if (!formats.length) throw new Error(t("Pick at least one format."));
    // Both ticked: file landscape; the vertical version follows once its script is approved.
    const format = formats.includes("landscape") ? "landscape" : "vertical", bothFormats = formats.length === 2;
    const who = document.querySelector('input[name="presenter"]:checked').value;
    const presenter = who !== "voice";
    const twinPresenter = bothFormats ? document.querySelector('input[name="presenter2"]:checked').value !== "voice" : undefined;
    // One story in several languages: one job per language, linked by a shared group id.
    const group = langs.length > 1 ? crypto.randomUUID() : undefined;
    const jobs = [];
    for (const lang of langs) {
      try { jobs.push(await api("/api/jobs", { method: "POST", body: JSON.stringify({ input: $("#input").value, brief: $("#brief").value, lang, format, bothFormats, presenter, twinPresenter, group, ...(pendingSource && { source: pendingSource }) }) })); }
      catch (err) {
        if (!jobs.length) throw err;
        for (const j of jobs) document.querySelector(`input[name="lang"][value="${j.lang}"]`).checked = false;
        throw new Error(t("Filed {filed} (see the rundown). {lang} failed: {error} Submit again for the rest.", { filed: jobs.map((j) => LANG[j.lang]?.[1]).join(", "), lang: LANG[lang]?.[1], error: t(err.message) }));
      }
    }
    $("#input").value = ""; $("#brief").value = ""; pendingSource = null; $("#source-note").hidden = true;
    open(jobs[0].id);
  } catch (err) { $("#new-err").textContent = t(err.message); $("#new-err").hidden = false; }
  btn.disabled = false;
});

const rupees = (x) => `₹${(x ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
let creditsAt = 0;
async function showCredits() {
  if (Date.now() - creditsAt < 30_000) return;
  creditsAt = Date.now();
  const u = await api("/api/usage").catch(() => null);
  if (!u) return;
  const c = u.voice, m = u.month, left = Math.max(0, c.limit - c.used), n = (x) => x.toLocaleString("en-IN");
  $("#credits").hidden = false;
  $("#credits").classList.toggle("low", left < c.limit * 0.15);
  const nums = { left: n(left), limit: n(c.limit) }, spent = { total: `<b>${rupees(m.total)}</b>`, n: m.stories };
  $("#credits").innerHTML = `${c.source === "app" ? t("Voice: {left} of {limit} characters left this month (counted by this app)", nums) : t("Voice: {left} of {limit} characters left this month", nums)}
    <meter min="0" max="${c.limit}" value="${left}" low="${c.limit * 0.15}" optimum="${c.limit}"></meter>
    <span class="spend">${m.stories === 1 ? t("{total} this month across {n} story", spent) : t("{total} this month across {n} stories", spent)}</span>
    <span class="parts"><span>${t("Script {amount}", { amount: rupees(m.script) })}</span><span>${t("Voice {amount}", { amount: rupees(m.voice) })}</span><span>${t("Presenter {amount}", { amount: rupees(m.presenter) })}</span></span>
    ${u.accounts?.length > 1 ? `<span class="parts">${u.accounts.map((a) => `<span>${esc(a.email)} ${rupees(a.total)}</span>`).join("")}</span>` : ""}`;
}

let rundownFilter = "all";
$("#rd-filter").addEventListener("click", (e) => {
  const b = e.target.closest("[data-filter]");
  if (!b) return;
  rundownFilter = b.dataset.filter;
  listJobs(new URLSearchParams(location.search).get("job"));
});

async function listJobs(current) {
  showCredits();
  const jobs = await api("/api/jobs");
  // The React finished-videos carousel listens; dvJobs covers a list sent before it mounted.
  window.dvJobs = jobs;
  bulletinPicker(jobs);
  dispatchEvent(new CustomEvent("dv:jobs", { detail: jobs }));
  const MIX = [[(n) => t("{n} ready", { n }), "var(--dv-accent-text)", (j) => j.status === "done"], [(n) => t("{n} waiting for you", { n }), "#f0b43c", (j) => j.status.endsWith("_review")],
    [(n) => t("{n} working", { n }), "var(--dv-text)", (j) => BUSY.has(j.status)], [(n) => t("{n} stopped", { n }), "var(--dv-line-hi)", (j) => j.status === "error"]]
    .map(([name, c, test]) => [name, c, jobs.filter(test).length]).filter(([, , n]) => n);
  const legend = MIX.map(([name, c, n]) => `<span style="--c:${c}">${name(n)}</span>`).join("");
  if ($("#mix-legend").innerHTML !== legend) { // only when the counts change, so the bar doesn't regrow on every poll
    $("#mix").innerHTML = MIX.map(([, c, n], k) => `<i style="--n:${n};--c:${c};animation-delay:${k * 120}ms"></i>`).join("");
    $("#mix-legend").innerHTML = legend;
  }
  $("#n-filed").textContent = jobs.length;
  $("#n-done").textContent = jobs.filter((j) => j.status === "done").length;
  // Home strip: the template previews plus a still from up to eight finished videos.
  const stills = [
    ...Object.values(TPL).map(([, dir]) => `/templates/${dir}.jpg`),
    ...jobs.filter((j) => j.status === "done").slice(0, 8).map((j) => `/media/${j.id}/poster.jpg`),
  ];
  press?.setImages(stills);
  buildWall($("#wall"), stills, jobs.filter((j) => j.headline).slice(0, 12));
  // Rundown filter: everything, or only stories a person should look at closely.
  const shown = rundownFilter === "review" ? jobs.filter((j) => j.review) : jobs;
  setHtml($("#rd-filter"), `<button type="button" data-filter="all" aria-pressed="${rundownFilter === "all"}">${t("All")}</button><button type="button" data-filter="review" aria-pressed="${rundownFilter === "review"}">${t("Needs review")} <b>${jobs.filter((j) => j.review).length}</b></button>`);
  setHtml($("#jobs"), shown.slice(0, 20).map((j) => `<li><a href="?job=${j.id}" data-id="${j.id}" ${j.id === current ? 'aria-current="true"' : ""}>
    <span class="glyph" title="${LANG[j.lang]?.[1] ?? j.lang}" aria-hidden="true">${LANG[j.lang]?.[0] ?? j.lang}</span>
    <span><span class="t" lang="${j.lang}" translate="no">${j.format === "vertical" ? `<span class="fmt" title="${esc(t("Shorts & Reels"))}">9:16</span>` : ""}${esc(j.headline || t("Writing the script…"))}</span><span class="m">${j.review ? `<span class="rv">${t("Needs review")}</span>` : ""}${esc(SAY[j.status] ?? j.status)}</span></span></a></li>`).join("")
    || `<li class="muted" style="padding:12px">${t("Stories you file appear here.")}</li>`);
}
// Rewrite only on change: a rebuild every poll throws keyboard focus back to the top of the page.
function setHtml(el, html) { if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; } }
for (const list of ["#jobs", "#job"]) $(list).addEventListener("click", (e) => { const a = e.target.closest("a[data-id]"); if (a) { e.preventDefault(); open(a.dataset.id); } });
for (const id of ["#home-link", "#new-link"]) $(id).addEventListener("click", (e) => { e.preventDefault(); history.pushState(null, "", "/"); home(); scrollTo({ top: 0 }); });
$("#nav-desk").addEventListener("click", (e) => { if (!document.body.classList.contains("is-home")) { e.preventDefault(); history.pushState(null, "", "/"); home(); requestAnimationFrame(() => $("#desk").scrollIntoView()); } });

function open(id) { history.pushState(null, "", `?job=${id}`); show(id); scrollTo({ top: 0 }); }
addEventListener("popstate", () => route());
addEventListener("dv:open", (e) => open(e.detail));
// Template cards: start a story with that template's brief, or in the vertical format.
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-brief], [data-format]");
  if (!b) return;
  if (b.dataset.brief !== undefined) $("#brief").value = b.dataset.brief;
  for (const f of ["landscape", "vertical"]) $(`#fmt-${f}`).checked = f === (b.dataset.format ?? "landscape");
  $("#desk").scrollIntoView({ behavior: "smooth" });
  $("#input").focus({ preventScroll: true });
});
function route() {
  const q = new URLSearchParams(location.search);
  q.get("job") ? show(q.get("job")) : q.get("view") === "bulletins" ? bulletins() : home();
}
// Bulletins on a page of their own (the Bulletins tab), with the rundown beside them.
function bulletins() {
  view++;
  clearTimeout(timer);
  clearInterval(railTick);
  setMode("bulletins");
  loadBulletins();
  listJobs();
}
$("#nav-bulletins").addEventListener("click", (e) => { e.preventDefault(); history.pushState(null, "", "/?view=bulletins"); bulletins(); scrollTo({ top: 0 }); });

function setMode(mode) {
  document.body.classList.remove("is-home", "is-job", "is-bulletins");
  document.body.classList.add(`is-${mode}`);
  $(mode === "job" ? "#stage-host" : "#hero-host").append(canvas);
  $("#desk").hidden = $("#inbox").hidden = mode !== "home";
  $("#bulletins").hidden = mode !== "bulletins";
  $("#job").hidden = mode !== "job";
  $("#nav-bulletins").toggleAttribute("aria-current", mode === "bulletins");
  if (mode === "bulletins") $("#nav-bulletins").setAttribute("aria-current", "page");
  if (mode !== "job") { $("#facts").hidden = true; shownId = null; }
  requestAnimationFrame(segFades); // rows hidden until now can only be measured once shown
}

// Bulletins: stories with a video can be ticked in play order; made bulletins list below with their video.
let blOrder = [], blTimer;
function bulletinPicker(jobs) {
  const ready = jobs.filter((j) => j.hasVideo);
  blOrder = blOrder.filter((id) => ready.some((j) => j.id === id));
  $("#bl-pick").innerHTML = ready.slice(0, 30).map((j) => `<li><input type="checkbox" id="bl-${j.id}" value="${j.id}" ${blOrder.includes(j.id) ? "checked" : ""}><label for="bl-${j.id}">
    <span class="no">${blOrder.includes(j.id) ? blOrder.indexOf(j.id) + 1 : ""}</span><span lang="${j.lang}" translate="no">${esc(j.headline ?? "")}</span><span class="meta">${LANG[j.lang]?.[1] ?? j.lang}${j.format === "vertical" ? ", 9:16" : ""}</span></label></li>`).join("")
    || `<li class="muted">${t("Stories with a draft or final video appear here.")}</li>`;
  $("#bl-make").disabled = blOrder.length < 2;
  $("#bl-note").textContent = blOrder.length === 1 ? t("Pick at least one more story") : blOrder.length ? t("{n} stories", { n: blOrder.length }) : "";
}
$("#bl-pick").addEventListener("change", (e) => {
  const id = e.target.value;
  blOrder = e.target.checked ? [...blOrder, id] : blOrder.filter((x) => x !== id);
  bulletinPicker(window.dvJobs ?? []);
  document.getElementById(`bl-${id}`)?.focus();
});
$("#bl-new").addEventListener("submit", async (e) => {
  e.preventDefault();
  e.submitter.disabled = true;
  try { await api("/api/bulletins", { method: "POST", body: JSON.stringify({ title: $("#bl-title").value, stories: blOrder }) }); blOrder = []; $("#bl-title").value = ""; bulletinPicker(window.dvJobs ?? []); loadBulletins(); }
  catch (err) { say(err); e.submitter.disabled = false; }
});
async function loadBulletins() {
  clearTimeout(blTimer);
  const list = await api("/api/bulletins").catch(() => []);
  $("#bl-list").innerHTML = list.slice(0, 10).map((b) => `<li>
    <div><b translate="no">${esc(b.title)}</b> <span class="muted">${b.seconds ? t("{n} stories, {format}, {seconds} s", { n: b.stories.length, format: b.format === "vertical" ? t("Shorts & Reels") : t("landscape"), seconds: b.seconds })
      : t("{n} stories, {format}", { n: b.stories.length, format: b.format === "vertical" ? t("Shorts & Reels") : t("landscape") })}</span></div>
    ${b.status === "done" ? `<video controls preload="none" src="/media/bulletins/${b.file}"></video><a href="/media/bulletins/${b.file}" download>${t("Download MP4")}</a>`
      : b.status === "error" ? `<div class="err">${esc(t(b.error))}</div>` : `<div class="muted">${b.status === "queued" ? t("In the queue") : t("Joining the stories…")}</div>`}
    <ol class="muted" style="margin:0;padding-left:20px" translate="no">${b.headlines.map((h) => `<li>${esc(h)}</li>`).join("")}</ol>
  </li>`).join("");
  if (list.some((b) => b.status === "queued" || b.status === "making")) blTimer = setTimeout(loadBulletins, 3000);
}

// Template designer: drafts with previews; approved looks join TPL so the script review picker offers them.
let dzTimer;
async function loadDesigns() {
  clearTimeout(dzTimer);
  const list = await api("/api/templates").catch(() => []);
  await meReady; // approve and reject are the owner's
  for (const d of list) if (d.status === "approved") TPL[d.id] = [d.name, d.id, d.description];
  const base = $("#dz-base").value;
  $("#dz-base").innerHTML = Object.entries(TPL).map(([k, [name]]) => `<option value="${k}">${esc(name)}${k.startsWith("c-") ? ` ${t("(your look)")}` : ""}</option>`).join("");
  if (base) $("#dz-base").value = base;
  $("#dz-list").innerHTML = list.slice(0, 12).map((d) => `<li>
    ${d.status === "draft" || d.status === "approved" ? `<img src="/templates/${d.id}.jpg?v=${d.status}" alt="${t("Preview of {name}", { name: esc(d.name) })}">` : ""}
    <div><b translate="no">${esc(d.name)}</b> ${d.status === "approved" ? `<span class="ok">${t("Approved")}</span>` : d.status === "draft" ? `<span class="rv">${t("Draft")}</span>` : ""}</div>
    <div class="muted" style="font-size:14px">${d.description ? esc(d.description) : t("Asked: “{request}”", { request: esc(d.request) })}${d.description ? ` <span>${t("(from {look})", { look: esc(TPL[d.from]?.[0] ?? d.from) })}</span>` : ""}</div>
    ${d.status === "making" ? `<div class="muted">${t("Designing and checking…")}</div>` : d.status === "error" ? `<div class="err">${esc(t(d.error))}</div>` : ""}
    ${me?.role === "owner" ? `<div class="row">${d.status === "draft" ? `<button type="button" class="primary" data-dz="${d.id}" data-to="approved">${t("Approve")}</button>` : ""}<button type="button" class="quiet" data-dz="${d.id}" data-to="rejected">${d.status === "approved" ? t("Remove") : t("Reject")}</button></div>` : ""}
  </li>`).join("");
  if (list.some((d) => d.status === "making")) dzTimer = setTimeout(loadDesigns, 4000);
}
$("#dz").addEventListener("submit", async (e) => {
  e.preventDefault();
  e.submitter.disabled = true;
  try { await api("/api/templates", { method: "POST", body: JSON.stringify({ base: $("#dz-base").value, request: $("#dz-request").value }) }); $("#dz-request").value = ""; loadDesigns(); }
  catch (err) { say(err); }
  e.submitter.disabled = false;
});
$("#dz-list").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-dz]");
  if (!b || (b.dataset.to === "rejected" && !confirm(t("Delete this look?")))) return;
  try { await api(`/api/templates/${b.dataset.dz}/status`, { method: "POST", body: JSON.stringify({ status: b.dataset.to }) }); if (b.dataset.to === "rejected") delete TPL[b.dataset.dz]; loadDesigns(); }
  catch (err) { say(err); }
});
loadDesigns();

function home() {
  view++;
  clearTimeout(timer);
  clearInterval(railTick);
  loadInbox();
  loadBulletins();
  setMode("home");
  press?.showHome();
  onScroll();
  listJobs();
}

// Each view (home, bulletins, a story) takes a number; a reply for an older view is dropped, so a slow poll
// for story A can't pull the page back to A after the editor moved on.
let view = 0;
async function show(id) {
  await meReady;
  clearTimeout(timer);
  const mine = ++view;
  let job;
  try { job = await api(`/api/jobs/${id}`); } catch (err) {
    if (mine !== view) return;
    setMode("job"); clearInterval(railTick); $("#rail").innerHTML = ""; $("#rail-say").textContent = $("#rail-time").textContent = ""; $("#job-body").innerHTML = `<div class="err">${esc(t(err.message))}</div>`;
    $("#stage-line").textContent = ""; return; // setMode left #facts from the last story; nothing of it belongs here
  }
  if (mine !== view) return;
  setMode("job");
  render(job);
  // The 3D stage is decoration: if it fails, the story page and its polling must carry on.
  try { press?.setScroll(0); press?.showJob({ headline: job.script?.headline, category: job.script?.category, status: job.status, lang: job.lang }); }
  catch (e) { console.error("3D stage:", e); }
  $("#stage-line").textContent = job.script?.headline || t("Reading your story…");
  $("#stage-line").lang = job.lang;
  $("#stage-state").textContent = job.ahead ? (job.ahead === 1 ? t("In the queue: 1 story ahead of yours") : t("In the queue: {n} stories ahead of yours", { n: job.ahead })) : SAY[job.status] ?? job.status;
  listJobs(id);
  if (BUSY.has(job.status)) timer = setTimeout(() => show(id), job.status === "script" ? 600 : 2500); // faster while the script is being written
}

// The rail is built once and then updated in place, so its transitions play instead of restarting on every poll.
// Step icons (24px stroke paths) and who does the work while a step runs, shown on the chip over the flowing line.
const ICONS = [
  '<path d="M6 3h9l3 3v15H6z"/><path d="M9 10h6M9 14h6M9 18h4"/>',
  '<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>',
  '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9.5v5l4.5-2.5z"/>',
  '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>',
  '<path d="M4 7l8-4 8 4-8 4z"/><path d="M4 12l8 4 8-4M4 17l8 4 8-4"/>',
];
const VIA = { script: "Gemini", voice: "ElevenLabs", compose: "HyperFrames", draft: "HyperFrames", avatar: "HeyGen", final: "HyperFrames", publish: "Gemini", youtube: "YouTube" };
const YOUR_TURN = { script_review: t("Your turn: review the script"), voice_review: t("Your turn: listen to the voice"), draft_review: t("Your turn: approve the draft") };
let railTick, railAt = {};
const STILL = matchMedia("(prefers-reduced-motion: reduce)");
function updateRail(job) {
  const ol = $("#rail");
  if (!ol.children.length) ol.innerHTML = RAIL.map(([label, , stop], i) => `<li><button type="button" class="goto" ${stop ? `data-act="back" data-to="${stop}"` : ""} disabled>
    <span class="node" aria-hidden="true"><svg class="ico" viewBox="0 0 24 24">${ICONS[i]}</svg><b>!</b><svg class="tick" viewBox="0 0 24 24"><path d="M5 12.5l4.2 4.2L19 7"/></svg><svg class="undo" viewBox="0 0 24 24"><path d="M4 5v5h5"/><path d="M5 10a8 8 0 1 1 1.7 6.3"/></svg></span>
    <span class="lbl">${label}</span></button></li>`).join("");
  const at = job.status === "error" ? job.error.split(":")[0] : job.status;
  const state = job.status === "done" ? "done" : job.status === "error" ? "error" : BUSY.has(job.status) ? "busy" : "waiting";
  const idx = state === "done" ? RAIL.length - 1 : Math.max(0, RAIL.findIndex(([, keys]) => keys.includes(at)));
  ol.dataset.state = $("#rail-status").dataset.state = state;
  ol.style.setProperty("--p", String(idx / (RAIL.length - 1)));
  const wrap = $("#rail-wrap");
  wrap.style.setProperty("--i", String(idx));
  wrap.toggleAttribute("data-flow", state === "busy" && idx > 0);
  if ($("#rail-chip").textContent !== (VIA[job.status] ?? "")) $("#rail-chip").replaceWith(Object.assign($("#rail-chip").cloneNode(), { textContent: VIA[job.status] ?? "" })); // fresh node replays the chip's entrance
  // Moving between steps: nodes change one after another, starting next to where the job was, and the page slides in from the side it came from.
  const from = railAt.id === job.id ? railAt.idx : idx;
  railAt = { id: job.id, idx };
  [...ol.children].forEach((li, i) => li.style.setProperty("--d", `${Math.max(0, idx < from ? from - i : i - from) * 110}ms`));
  if (idx !== from && !STILL.matches) $("#job-body").animate([{ opacity: 0, transform: `translateX(${idx < from ? -36 : 36}px)` }, { opacity: 1, transform: "none" }], { duration: 520, easing: "cubic-bezier(.2,.7,.2,1)" });
  [...ol.children].forEach((li, i) => {
    const btn = li.firstElementChild, stop = RAIL[i][2];
    btn.disabled = !job.back?.includes(stop);
    btn.title = btn.disabled ? "" : t("Go back to {step}", { step: RAIL[i][0].toLowerCase() });
    li.classList.toggle("done", state === "done" || i < idx);
    li.classList.toggle("now", state !== "done" && i === idx);
    if (RAIL[i][0] === t("Presenter")) { li.classList.toggle("skip", job.presenter === false); li.querySelector(".lbl").textContent = job.presenter === false ? t("No presenter") : t("Presenter"); }
    if (state !== "done" && i === idx) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
  });
  $("#rail-say").textContent = state === "busy" ? SAY[job.status] : state === "waiting" ? YOUR_TURN[job.status] ?? SAY[job.status] : state === "error" ? t("Stopped at {step}", { step: RAIL[idx][0].toLowerCase() }) : t("Final video ready");
  // While a step runs, count from when the server started it (the job is saved as each step starts).
  clearInterval(railTick);
  $("#rail-time").textContent = "";
  if (state === "busy") {
    const since = Date.parse(job.updatedAt) || Date.now();
    const tick = () => { $("#rail-time").textContent = t("· {n}s", { n: Math.max(0, Math.round((Date.now() - since) / 1000)) }); };
    tick(); railTick = setInterval(tick, 1000);
  }
}

function picker(s) {
  const chosen = TPL[s.template] ? s.template : "lead"; // a removed look, or looks not loaded yet: still one picked
  return `<span class="label" id="tpl-l">${t("Template")}</span>
    <div class="tpl" role="radiogroup" aria-labelledby="tpl-l">${Object.entries(TPL).map(([key, [name, dir, desc]]) => `
      <input type="radio" name="tpl" id="tpl-${key}" value="${key}" ${key === chosen ? "checked" : ""}>
      <label for="tpl-${key}"><img src="/templates/${dir}.jpg" alt="" loading="lazy">
        <span class="txt"><span class="name">${esc(name)}${key === s.template ? `<span class="chip">${t("AI pick")}</span>` : ""}</span><span class="desc">${esc(desc)}</span></span></label>`).join("")}
    </div>
    ${s.template_reason ? `<p class="reason">${t("Why this template: {reason}", { reason: esc(s.template_reason) })}</p>` : ""}`;
}

let shownId;
// Hand adjustments at draft review: the on-screen words (the narration needs a new voice, so it isn't here) and, for
// each photo or clip, when it shows (empty: placed automatically) and whether it shows at all.
function adjustHtml(job) {
  const s = job.script ?? {}, when = new Map((job.timeline?.media ?? []).map((m) => [m.file, m.t])), framed = job.timeline?.framed?.file;
  const media = (job.photos ?? []).filter((p) => p.file !== framed), off = new Set(job.cutawayOff ?? []);
  return `<form id="adjust" class="change" lang="${job.lang}">
    <h3>${t("Adjust the draft")} <span class="opt">${t("no new voice: only the draft is made again")}</span></h3>
    ${canStudio() ? `<p class="muted">${t("This rebuilds the page: Studio edits stay in the version you rendered them in.")}</p>` : ""}
    <label for="aj-category">${t("Category")}</label><input id="aj-category" value="${esc(s.category)}" required>
    <label for="aj-headline">${t("Headline")}</label><input id="aj-headline" value="${esc(s.headline)}" required>
    <label for="aj-standfirst">${t("Standfirst")}</label><textarea id="aj-standfirst" rows="2">${esc(s.standfirst)}</textarea>
    <label for="aj-ticker">${t("Ticker")} <span class="opt">${t("Press Enter between ticker items")}</span></label><textarea id="aj-ticker" rows="3">${esc((s.ticker ?? []).join("\n"))}</textarea>
    ${media.length ? `<h4>${t("Photos and clips")}</h4><ul class="aj-media">${media.map((p, i) => {
      const t0 = when.get(p.file), label = p.kind === "clip" ? t("Clip {n}", { n: i + 1 }) : t("Photo {n}", { n: i + 1 });
      return `<li data-file="${esc(p.file)}" data-t="${t0 ?? ""}"><img src="/media/${job.id}/photos/${esc(p.poster ?? p.file)}" alt="${esc(label)}">
        <label><input type="checkbox" ${off.has(p.file) ? "" : "checked"}> ${esc(label)}</label>
        <label>${t("Starts at")} <input type="number" min="0" max="${job.seconds ?? 0}" step="any" value="${t0 ?? ""}" placeholder="${esc(t("automatic"))}" aria-label="${esc(t("{label}: starts at, in seconds", { label }))}"> ${t("s")}</label></li>`;
    }).join("")}</ul>` : ""}
    <div class="row"><button type="submit" class="primary">${t("Remake the draft")}</button></div>
  </form>`;
}

// The draft as a timeline: the voice sentence by sentence, and what fills the screen when, each with its reason on hover.
const timelineHtml = (job) => {
  const tl = job.timeline, pct = (x) => `${Math.max(0, Math.min(100, (x / tl.total) * 100)).toFixed(2)}%`;
  const at = (a, b) => `left:${pct(a)};width:${pct(b - a)}`;
  const base = job.presenter !== false ? t("The presenter at the desk") : job.format !== "vertical" ? t("The story text, full width")
    : job.photos?.some((p) => p.kind !== "clip") ? t("Story photos in the presenter panel") : t("Dashavani card in the presenter panel");
  const ticks = Array.from({ length: Math.floor(tl.total / 5) + 1 }, (_, i) => `<span style="left:${pct(i * 5)}">${i * 5}s</span>`).join("");
  return `<section class="timeline" aria-labelledby="tl-h"><h3 id="tl-h">${t("Timeline")} <span class="opt" style="font-size:16px">${job.bumpers === false ? t("the {n}-second story; hover a block for the reason", { n: tl.total - 1 }) : t("the {n}-second story, between the intro and the end card; hover a block for the reason", { n: tl.total - 1 })}</span></h3>
    <div class="tl-row"><span class="tl-name">${t("On screen")}</span><div class="tl-track">
      <i class="tl-base" title="${tl.framed ? esc(t("{base}, over the {from} photo filling the frame", { base, from: tl.framed.from })) : esc(base)}"></i>
      ${tl.media.map((m, i) => { const span = { n: i + 1, from: esc(m.from), start: m.t, end: (m.t + m.show).toFixed(1) }; return `<i class="tl-${m.kind}" style="${at(m.t, m.t + m.show)}" title="${m.kind === "clip" ? t("Clip {n} from {from}, {start}–{end} s.", span) : t("Photo {n} from {from}, {start}–{end} s.", span)} ${m.snapped ? t("Starts with a sentence, at a pause in the voice.") : t("Evenly spaced: no sentence started close by.")}${m.kind === "clip" ? ` ${t("Plays silently.")}` : ""}"></i>`; }).join("")}
    </div></div>
    <div class="tl-row"><span class="tl-name">${t("Voice")}</span><div class="tl-track">
      ${tl.sentences.map((x, i) => `<i class="tl-say ${i % 2 ? "odd" : ""}" style="${at(x.s, x.e)}" title="${t("Sentence {n}, {start}–{end} s: {text}", { n: i + 1, start: x.s.toFixed(1), end: x.e.toFixed(1), text: esc(x.text) })}"></i>`).join("")}
    </div></div>
    <div class="tl-ticks">${ticks}</div>
    <p class="tl-key"><i class="tl-base"></i>${esc(base)} <i class="tl-photo"></i>${t("Photo")} <i class="tl-clip"></i>${t("Clip")} <i class="tl-say"></i>${t("Sentence")}</p>
  </section>`;
};
// The script as it stands in the review form.
const formScript = (s) => ({
  template: document.querySelector('input[name="tpl"]:checked').value, template_reason: s.template_reason ?? "",
  headline: $("#f-headline").value, category: $("#f-category").value, standfirst: $("#f-standfirst").value,
  dateline_city: $("#f-city").value, narration: $("#f-narration").value, source_name: $("#f-src").value,
  figure_value: $("#f-fv").value, figure_label: $("#f-fl").value, figure_context: $("#f-fc").value,
  quote_text: $("#f-qt").value, quote_by: $("#f-qb").value,
  ticker: $("#f-ticker").value.split("\n").map((t) => t.trim()).filter(Boolean),
});
const englishHtml = (e) => !e ? `<p class="muted">${t('Not available yet. Press "Update after my edits".')}</p>` : `<dl>
  <dt>${t("Headline")}</dt><dd translate="no">${esc(e.headline)}</dd>${e.standfirst ? `<dt>${t("Standfirst")}</dt><dd translate="no">${esc(e.standfirst)}</dd>` : ""}
  <dt>${t("Narration")}</dt><dd translate="no">${esc(e.narration)}</dd>${e.ticker?.length ? `<dt>${t("Ticker")}</dt><dd translate="no">${e.ticker.map(esc).join("<br>")}</dd>` : ""}${e.quote_text ? `<dt>${t("Quote")}</dt><dd translate="no">${esc(e.quote_text)}</dd>` : ""}</dl>`;
// Subtitle tracks and the language shown on the picture: at script review, and again once the video is finished.
const subtitlePicker = (job) => {
        const plan = subPlan(job), langs = Object.keys(LANG).sort((a, b) => (a === job.lang ? -1 : b === job.lang ? 1 : 0));
        const name = (k) => (k === job.lang ? t("{lang} (as spoken)", { lang: LANG[k][1] }) : LANG[k][1]);
        return `<span class="label" id="subl-l">${t("Subtitle languages")} <span class="opt">${t("(viewers pick one with the CC button)")}</span></span>
      <div class="seg" role="group" aria-labelledby="subl-l">
        ${langs.map((k) => `<input type="checkbox" name="subl" id="subl-${k}" value="${k}" ${plan.langs.includes(k) ? "checked" : ""}><label for="subl-${k}" lang="${k}">${name(k)}</label>`).join("")}
      </div>
      <span class="label" id="burn-l">${t("Show on the video")}</span>
      <div class="seg" role="radiogroup" aria-labelledby="burn-l">
        ${[...langs, "off"].map((k) => `<input type="radio" name="burn" id="burn-${k}" value="${k}" ${plan.burn === k ? "checked" : ""}><label for="burn-${k}" ${k !== "off" ? `lang="${k}"` : ""}>${k === "off" ? t("None") : LANG[k][1]}</label>`).join("")}
      </div>
      <p class="hint" style="margin-top:8px">${t("Each ticked language becomes a subtitle track inside the MP4 and a file to upload to YouTube. The one shown on the video is also burned into the picture, for Reels and Shorts, which cannot switch tracks. Subtitles in the spoken language light up each word; other languages are translated sentence by sentence, so check them on the draft.")}</p>`;
};
// What the picker says, as the server wants it; the language shown on the video is always also a track.
const pickedSubs = () => {
  const burn = document.querySelector('input[name="burn"]:checked').value;
  return { subLangs: [...new Set([...document.querySelectorAll('input[name="subl"]:checked')].map((i) => i.value).concat(burn === "off" ? [] : [burn]))], burn };
};
// Same rules as the server's subtitlePlan: older stories had one choice in job.subs.
const subPlan = (job) => job.subLangs ? { langs: job.subLangs, burn: job.burn ?? "off" } : (job.subs ?? job.lang) === "off" ? { langs: [], burn: "off" } : { langs: [job.subs ?? job.lang], burn: job.subs ?? job.lang };
// Subtitle tracks for the in-app player, so its CC button lists every language.
const tracks = (job) => (job.subFiles ?? []).map((l) => `<track kind="subtitles" srclang="${l}" label="${LANG[l]?.[1] ?? l}" src="/media/${job.id}/subtitles/${l}.vtt?t=${encodeURIComponent(job.updatedAt)}">`).join("");
// Download a final in a chosen size, with all, one or no subtitle tracks.
const QUAL = [["original", t("Original (full HD)")], ["720", t("720p (smaller file)")], ["480", t("480p (smallest, for WhatsApp)")]];
const downloadHtml = (job) => {
  const tracks = job.subFiles ?? [], burned = subPlan(job).burn;
  return `<section class="publish" aria-labelledby="dl-h"><h3 id="dl-h">${t("Download")}</h3>
    <div class="row" style="flex-wrap:wrap;gap:12px;align-items:end">
      <label>${t("Version")} <select id="dl-v">${[...job.finals].reverse().map((f) => `<option value="${f}">${f.replace(".mp4", "").replace("final-", "")}</option>`).join("")}</select></label>
      <label>${t("Quality")} <select id="dl-q">${QUAL.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
      <label>${t("Subtitle tracks")} <select id="dl-s">${tracks.length ? `<option value="all">${t("All ({langs})", { langs: tracks.map((l) => LANG[l]?.[1] ?? l).join(", ") })}</option>${tracks.map((l) => `<option value="${l}">${t("{lang} only", { lang: LANG[l]?.[1] ?? l })}</option>`).join("")}` : ""}<option value="none">${t("None")}</option></select></label>
      <a class="btn" id="dl-go">${t("Download MP4")}</a>
    </div>
    <p class="hint" style="margin-top:8px">${t("Tracks are switched on in the player's CC menu.")}${burned !== "off" ? ` ${t("{lang} subtitles are part of the picture and stay in every download; change them under Subtitles below.", { lang: esc(LANG[burned]?.[1] ?? burned) })}` : ""} ${t("Smaller sizes take a few seconds to prepare.")}</p>
  </section>`;
};
const dlHref = (id) => `/media/${id}/download/${$("#dl-v").value}?q=${$("#dl-q").value}&subs=${$("#dl-s").value}`;

// Publishing text with copy buttons, and the YouTube upload (always private; scheduled if a time is given).
const PACK = [["youtube_title", t("YouTube title")], ["youtube_description", t("YouTube description")], ["tags", t("Tags")], ["hashtags", t("Hashtags")], ["instagram_caption", t("Instagram caption")], ["x_post", t("X post")]];
const publishHtml = (job) => {
  const p = job.publish, yt = job.youtube;
  if (!p) return `<section class="publish"><h3>${t("Publish pack")}</h3>${job.publishError ? `<p class="err">${esc(t(job.publishError))}</p>` : ""}<div class="row"><button type="button" class="quiet" data-act="publish-pack">${t("Write the publish pack")}</button></div></section>`;
  const text = (k) => Array.isArray(p[k]) ? p[k].join(k === "tags" ? ", " : " ") : p[k];
  return `<section class="publish" aria-labelledby="pb-h"><h3 id="pb-h">${t("Publish pack")}</h3>
    ${PACK.map(([k, label]) => `<div class="pack-field"><div class="row" style="margin:10px 0 4px;justify-content:space-between"><b>${label}</b><button type="button" class="quiet" data-copy="${k}">${t("Copy")}</button></div><div class="source" id="pk-${k}" translate="no">${esc(text(k))}</div></div>`).join("")}
    <div class="row"><button type="button" class="quiet" data-act="publish-pack" data-confirm="${esc(t("Write the publish pack again? The current text is replaced."))}">${t("Write it again")}</button></div>
    <h3>YouTube</h3>
    ${yt ? `<p>${uploaded(yt)}</p>${yt.warnings?.length ? `<ul>${yt.warnings.map((w) => `<li class="muted">${esc(t(w))}</li>`).join("")}</ul>` : ""}` : ""}
    <label for="f-yt-at">${t("Release time (optional; leave empty to keep it private)")}</label><input id="f-yt-at" type="datetime-local">
    <div class="row"><button type="button" data-yt ${yt ? `data-confirm="${esc(t("This story is already on YouTube. Upload it again as a second video?"))}"` : ""}>${t("Upload to YouTube (private)")}</button></div>
  </section>`;
};
// One whole sentence per case, so each language can order the words its own way.
const uploaded = (yt) => {
  const v = { file: yt.file ? esc(yt.file.replace(".mp4", "").replace("final-", "")) : "", when: yt.publishAt ? esc(new Date(yt.publishAt).toLocaleString("en-IN")) : "", link: `<a href="${esc(yt.url)}" target="_blank" rel="noopener">${esc(yt.url)}</a>` };
  if (v.file) return v.when ? t("Uploaded {file} as private, goes public {when}: {link}", v) : t("Uploaded {file} as private: {link}", v);
  return v.when ? t("Uploaded as private, goes public {when}: {link}", v) : t("Uploaded as private: {link}", v);
};
const ago = (iso) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  const d = Math.round(m / 1440);
  return m < 1 ? t("Just now") : m < 60 ? t("{n} min ago", { n: m }) : m < 1440 ? t("{n} h ago", { n: Math.round(m / 60) }) : d === 1 ? t("{n} day ago", { n: d }) : t("{n} days ago", { n: d });
};
// Story details under the story panel: template preview, language, length, versions, filed time and source.
function renderFacts(job) {
  const s = job.script ?? {}, tpl = job.format === "vertical" ? [t("Shorts & Reels"), "vt05-shorts"] : TPL[s.template];
  const bars = Array.from({ length: 14 }, (_, k) => `<i style="--k:${k};--h:${(Math.sin(k * 1.7) + 1) / 2}"></i>`).join("");
  $("#facts").hidden = false;
  $("#facts").innerHTML = `
    <div class="fact tpl-fact">${tpl ? `<img src="/templates/${tpl[1]}.jpg" alt="">` : ""}<div><span>${t("Template")}</span><b style="display:block;margin-top:8px">${esc(tpl?.[0] ?? t("Not chosen yet"))}</b></div></div>
    <div class="fact"><span>${t("Language")}</span><b lang="${job.lang}">${LANG[job.lang]?.[1] ?? job.lang}</b></div>
    <div class="fact"><span>${t("Voice length")}</span>${job.seconds ? `<b>${t("{n} s", { n: job.seconds - 1 })}</b><div class="bars" aria-hidden="true">${bars}</div>` : `<b>${t("Not recorded")}</b>`}</div>
    <div class="fact"><span>${t("Filed")}</span><b>${ago(job.createdAt)}</b></div>
    <div class="fact"><span>${t("Versions")}</span><b>${job.finals?.length ?? 0}</b></div>
    <div class="fact cost-fact"><span>${t("Cost of this story")} <em>${t("(estimated at paid-plan rates)")}</em></span>
      <table><tbody>${[[t("Script"), "script", (n) => t("{n} tokens", { n })], [t("Voice"), "voice", (n) => t("{n} characters", { n })], [t("Presenter"), "presenter", (n) => t("{n} seconds", { n })]].map(([label, k, units]) =>
        `<tr><th scope="row">${label}</th><td>${job.cost?.[k] ? units(job.cost[k].units.toLocaleString("en-IN")) : k === "presenter" && job.presenter === false ? t("Voice only") : t("None yet")}</td><td>${rupees(job.cost?.[k]?.inr)}</td></tr>`).join("")}
        <tr class="total"><th scope="row">${t("Total")}</th><td></td><td>${rupees(["script", "voice", "presenter"].reduce((sum, k) => sum + (job.cost?.[k]?.inr ?? 0), 0))}</td></tr></tbody></table></div>
    <div class="fact src-fact"><span>${job.source ? t("From {source}, story {id}", { source: esc(job.source.name ?? t("a verified source")), id: esc(job.source.id ?? "") }) : t("Pasted by hand")}</span>${job.source?.url ? `<a href="${esc(job.source.url)}" target="_blank" rel="noopener">${t("Open original")}</a>` : ""}</div>`;
}

function render(job) {
  const s = job.script ?? {};
  const v = (k) => esc(s[k]);
  const tplName = job.format === "vertical" ? t("Shorts & Reels 9:16") : TPL[s.template]?.[0];
  const backTo = job.back?.length ? RAIL.find((r) => r[2] === job.back.at(-1))?.[0].toLowerCase() : undefined;
  updateRail(job);
  let body = "";
  // The script as Gemini writes it, before it is checked; the review form replaces it once it's done.
  if (job.writing?.narration || job.writing?.headline) body += `<div class="live-script" lang="${job.lang}" aria-live="polite"><h3>${esc(job.writing.headline)}</h3><p>${esc(job.writing.narration)}<span class="caret" aria-hidden="true"></span></p></div>`;
  if (job.status === "error") body += `<div class="err">${esc(t(job.error))}</div><div class="row"><button data-act="retry">${t("Retry this step")}</button>${backTo ? `<button class="quiet" data-act="back">${t("Back to {step}", { step: backTo })}</button>` : ""}</div>`;
  if (job.warnings?.length) body += `<div class="warn"><strong>${t("Check before approving.")}</strong> ${job.warnings.map((w) => esc(t(w))).join(". ")}.</div>`;
  const fmt = (f) => (f === "vertical" ? t("Shorts & Reels") : t("Landscape"));
  if (job.siblings?.length) body += `<p class="also">${t("Also in {list}", { list: job.siblings.map((o) => `<a href="?job=${o.id}" data-id="${o.id}" lang="${o.lang}">${o.lang !== job.lang ? LANG[o.lang]?.[1] ?? o.lang : ""}${o.lang !== job.lang && o.format !== (job.format ?? "landscape") ? ", " : ""}${o.format !== (job.format ?? "landscape") ? fmt(o.format) : ""}<span>${esc(SAY[o.status] ?? o.status)}</span></a>`).join("") })}</p>`;
  // The other format from this approved script: same voice and presenter (cached), only a new layout to render.
  const otherFmt = job.format === "vertical" ? "landscape" : "vertical";
  if (["draft_review", "done"].includes(job.status) && !job.siblings?.some((o) => o.lang === job.lang && o.format === otherFmt)) body += `<div class="row" style="margin:0 0 14px;flex-wrap:wrap;align-items:center"><div class="seg" role="radiogroup" aria-label="${esc(t("Presenter in the {format} version", { format: fmt(otherFmt) }))}">
    <input type="radio" name="tw-pres" id="tw-ai" value="ai" ${job.presenter === false ? "" : "checked"}><label for="tw-ai">${t("AI presenter")}</label>
    <input type="radio" name="tw-pres" id="tw-voice" value="voice" ${job.presenter === false ? "checked" : ""}><label for="tw-voice">${t("Voice only")}</label></div>
    <button type="button" class="quiet" data-convert>${t("Make {format} version", { format: fmt(otherFmt) })}</button></div>`;
  if (job.source) body += `<p class="muted" style="margin:0 0 6px">${t("Source: {source} story {id}. {link}", { source: esc(job.source.name ?? job.source.type), id: esc(job.source.id ?? job.source.prid), link: `<a href="${esc(job.source.url)}" target="_blank" rel="noopener">${t("Open original")}</a>` })}</p>`;
  if (job.brief) body += `<p class="muted" style="margin:0 0 6px">${t("Brief: {brief}", { brief: esc(job.brief) })}</p>`;

  if (job.status === "script_review") body += `
    ${job.scriptProblems?.length ? `<div class="err" role="alert">${t("Check before approving:")} ${job.scriptProblems.map(esc).join("; ")}
      ${job.scriptProblems.some((p) => / is not in /.test(p)) ? `<div class="row" style="margin-top:10px"><button type="button" class="quiet" data-act="fix-language">${t("Fix the language")}</button></div>` : ""}</div>` : ""}
    <form id="script" lang="${job.lang}" data-job="${job.id}">
      ${job.format === "vertical" ? `<span class="label">${t("Format")}</span><p class="reason" style="margin-top:0">${esc(t("Shorts & Reels, 9:16. The vertical layout is used for this story."))}</p><div hidden>${picker(s)}</div>` : picker(s)}
      <label for="f-headline">${t("Headline")}</label><input id="f-headline" data-fit="90" required value="${v("headline")}">
      <div class="grid2">
        <div><label for="f-category">${t("Category")}</label><input id="f-category" data-fit="24" required value="${v("category")}"></div>
        <div><label for="f-city">${t("Dateline city")}</label><input id="f-city" data-fit="30" value="${v("dateline_city")}"></div>
      </div>
      <label for="f-standfirst">${t("Standfirst")}</label><input id="f-standfirst" data-fit="120" value="${v("standfirst")}">
      <div id="figure-fields" ${s.template === "numbers" ? "" : "hidden"}>
        <div class="grid2">
          <div><label for="f-fv">${t("Key figure")}</label><input id="f-fv" data-fit="14" value="${v("figure_value")}"></div>
          <div><label for="f-fl">${t("What it measures")}</label><input id="f-fl" data-fit="40" value="${v("figure_label")}"></div>
        </div>
        <label for="f-fc">${t("Figure context")}</label><input id="f-fc" data-fit="90" value="${v("figure_context")}">
      </div>
      <div id="quote-fields" ${s.template === "quote" ? "" : "hidden"}>
        <label for="f-qt">${t("Quote")} <span class="opt">${t("(the exact words from the source)")}</span></label><textarea id="f-qt" data-fit="160" style="min-height:90px">${v("quote_text")}</textarea>
        <label for="f-qb">${t("Who said it")}</label><input id="f-qb" data-fit="50" value="${v("quote_by")}">
      </div>
      <label for="f-src">${t("Source")}</label><input id="f-src" data-fit="40" value="${v("source_name")}">
      <label for="f-narration">${t("Narration")} <span class="opt">${t("(what the presenter says)")}</span></label><textarea id="f-narration" maxlength="2500" required>${v("narration")}</textarea>
      <label for="f-ticker">${t("Ticker")} <span class="opt">${t("(one line each; Key Points uses these as its points)")}</span></label><textarea id="f-ticker" style="min-height:100px">${esc((s.ticker ?? []).join("\n"))}</textarea>
      <span class="label" id="pr-l">${t("Presenter")}</span>
      <div class="seg" role="radiogroup" aria-labelledby="pr-l">
        <input type="radio" name="presenter-r" id="pr-ai" value="ai" ${job.presenter === false ? "" : "checked"}><label for="pr-ai">${t("AI presenter")}</label>
        <input type="radio" name="presenter-r" id="pr-voice" value="voice" ${job.presenter === false ? "checked" : ""}><label for="pr-voice">${t("Voice only")}</label>
      </div>
      <p class="hint" style="margin-top:8px">${t("The AI presenter is your HeyGen avatar, lip-synced to the voice in the final video. Voice only skips HeyGen and its cost.")}</p>
      ${subtitlePicker(job)}
      <section class="photos" aria-labelledby="ph-h">
      <h3 id="ph-h">${t("Photos and clips")} <span class="opt" style="font-size:16px">${t("shown full screen while the presenter speaks, each starting at a pause in the voice")}</span></h3>
      <ul class="ph-grid">${(job.photos ?? []).map((p) => `<li><img src="/media/${job.id}/photos/${p.poster ?? p.file}" alt="${p.kind === "clip" ? t("Story clip") : t("Story photo")}"><span class="from">${esc(p.from)}${p.kind === "clip" ? `, ${t("clip {n} s", { n: p.seconds })}` : ""}</span>
        <button type="button" class="ph-del" data-photo="${p.file}" aria-label="${p.kind === "clip" ? t("Remove this clip") : t("Remove this photo")}">×</button></li>`).join("")}
        <li class="ph-add"><label for="ph-input">${t("Add photos or clips")}<span>${t("Photos up to 8 MB, clips (MP4, MOV, WebM) up to 100 MB")}</span></label><input id="ph-input" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm" multiple></li>
      </ul>
      ${job.photos?.length ? "" : `<p class="muted" style="margin:8px 0 0">${t("No photos or clips yet. Without them the presenter stays on screen the whole time.")}</p>`}
    </section>
      ${job.lang !== "en" ? `<section class="english" aria-labelledby="en-h">
        <h3 id="en-h">${t("English meaning")} <span class="opt" style="font-size:16px">${t("a literal translation, to check the {lang} script", { lang: LANG[job.lang]?.[1] })}</span></h3>
        <div id="english-body">${englishHtml(job.english)}</div>
        <div class="row"><button type="button" class="quiet" id="english-refresh">${t("Update after my edits")}</button></div>
      </section>` : ""}
      <label class="check"><input type="checkbox" id="f-bumpers" ${job.bumpers === false ? "" : "checked"}> ${t("Add the Dashavani intro, end card and music")}</label>
      <label class="check"><input type="checkbox" id="f-checked" required> ${t("I checked every line of the {lang} script against the source", { lang: LANG[job.lang]?.[1] ?? "" })}</label>
      <div class="row"><button type="submit" class="primary">${t("Approve script and make draft")}</button></div>
    </form>`;
  else if (job.script) body += `<span class="chip" lang="${job.lang}" translate="no">${v("category")}</span>${tplName ? ` <span class="muted" style="margin-left:8px">${esc(tplName)}</span>` : ""}<h2 class="headline" lang="${job.lang}" translate="no">${v("headline")}</h2><p class="muted" lang="${job.lang}" translate="no" style="font-size:20px;margin:0">${v("standfirst")}</p>`;

  if (job.voice && job.status !== "script_review") body += `
    <h3>${t("Voice")} <span class="opt" style="font-size:16px">${LANG[job.lang]?.[1] ?? ""}${job.seconds ? `, ${t("{n} seconds", { n: job.seconds - 1 })}` : ""}${job.voiceCached ? `, ${t("reused at no charge")}` : job.voiceChars ? `, ${t("{n} characters", { n: job.voiceChars.toLocaleString("en-IN") })}` : ""}${job.words?.length ? `, ${t("with subtitles")}` : ""}</span></h3>
    <audio controls preload="${job.status === "voice_review" ? "auto" : "none"}" src="/media/${job.id}/voice.wav?t=${job.voiceAt}"></audio>
    ${job.status === "voice_review" ? `<form id="revoice" lang="${job.lang}">
      <label for="f-voice-narration">${t("Narration")} <span class="opt">${t("(change it to record the voice again)")}</span></label><textarea id="f-voice-narration" maxlength="2500" required>${v("narration")}</textarea>
      <div class="row"><button type="submit" class="primary">${t("Record the voice again")}</button>
      <button type="button" class="quiet" data-act="keep-voice" data-confirm="${esc(t("This makes the draft again from this voice. Edits made to the draft in Studio will be replaced."))}">${t("Keep this voice and make the draft")}</button></div></form>` : ""}`;

  if (job.draft && job.status !== "voice_review" && (!job.finals?.length || job.status === "draft_review")) body += `
    <h3>${t("Draft")} <span class="opt" style="font-size:16px">${job.presenter === false ? t("voice only, no presenter") : t("with a placeholder presenter")}</span></h3>
    ${(job.subFiles ?? []).filter((l) => l !== job.lang && job.subTrans?.[l]).map((l) => `<details class="subtrans" ${job.status === "draft_review" ? "open" : ""}><summary>${t("{lang} subtitles (translated, please check)", { lang: LANG[l]?.[1] })}</summary><ol lang="${l}" translate="no">${job.subTrans[l].lines.map((x) => `<li>${esc(x)}</li>`).join("")}</ol></details>`).join("")}
    <video controls preload="none" poster="/media/${job.id}/poster.jpg?t=${encodeURIComponent(job.updatedAt)}" src="/media/${job.id}/${job.draft}?t=${encodeURIComponent(job.updatedAt)}">${tracks(job)}</video>
    ${job.status === "draft_review" ? `<div class="row">
      <button class="primary" data-act="approve-draft">${t("Approve and make the final video")}</button>
      ${canStudio() ? `<button class="quiet" data-studio>${t("Open in HyperFrames Studio")}</button><button class="quiet" data-act="studio-render">${t("Render Studio edits")}</button>` : `<button class="quiet" data-act="redo-draft">${t("Re-render draft")}</button>`}
      <button class="quiet" data-act="back" data-to="voice_review">${t("Back to voice")}</button>
      <button class="quiet" data-act="back" data-to="script_review" data-confirm="${esc(t("Going back to the script means the voice and draft are made again when you re-approve. Studio edits stay in the version you rendered them in; Use this version brings them back."))}">${t("Back to script")}</button></div>` : ""}`;

  if (job.finals?.length && job.status !== "draft_review") body += `
    <h3>${t("Final video")}</h3>
    <video controls preload="none" poster="/media/${job.id}/poster.jpg?t=${encodeURIComponent(job.updatedAt)}" src="/media/${job.id}/${job.finals.at(-1)}">${tracks(job)}</video>
    ${job.status === "done" ? `<div class="row">${canStudio() ? `<button class="quiet" data-studio>${t("Open in HyperFrames Studio")}</button>` : ""}<button data-act="rerender">${canStudio() ? t("Render Studio edits") : t("Re-render")}</button><button class="quiet" data-act="back" data-to="draft_review">${t("Back to draft")}</button></div>
      ${me?.role === "owner" ? `<p class="muted" style="margin-top:10px">${job.onIntro !== false ? t("Shown on the public intro (watch only; nobody can download or edit it).") : t("Hidden from the intro: only you can see this video.")} <button type="button" class="quiet" data-act="intro" data-on="${job.onIntro === false}">${job.onIntro !== false ? t("Hide from the intro") : t("Show on the intro")}</button></p>` : ""}` : ""}
    <p class="muted" style="margin-top:14px">${t("Versions: {list} · {thumbnail}", { list: job.finals.map((f) => `<a href="/media/${job.id}/${f}" download>${f.replace(".mp4", "").replace("final-", "")}</a>`).join(", "), thumbnail: `<a href="/media/${job.id}/thumbnail.jpg">${t("Thumbnail (JPG)")}</a>` })}</p>
    ${job.status === "done" ? downloadHtml(job) + `<form id="subs-form" class="publish"><h3>${t("Subtitles")}</h3>${subtitlePicker(job)}
      <div class="row"><button type="submit" class="quiet">${t("Make a new final with these subtitles")}</button></div></form>` + publishHtml(job) : ""}`;

  if (job.timeline && job.draft && job.status !== "script_review") body += timelineHtml(job);
  // Adjust the draft by hand, without a new voice: the words on screen and when each photo or clip shows.
  if (job.status === "draft_review") body += adjustHtml(job);
  // Ask for a change in plain words, and the versions so far.
  if (["draft_review", "done"].includes(job.status)) body += `<form id="change" class="change">
    <h3>${t("Ask for a change")}</h3>
    <textarea id="f-change" maxlength="500" required placeholder="${esc(t("Say it the way you would to an editor"))}"></textarea>
    <div class="chips">${[t("Make the headline shorter"), t("Use the Breaking template"), t("Make it voice only"), t("Add Tamil subtitles"), t("Use only the first three ticker lines"), t("Say the date at the start")].map((c) => `<button type="button" class="chip-btn">${c}</button>`).join("")}</div>
    <div class="row"><button type="submit" class="primary">${t("Make the next version")}</button></div>
  </form>`;
  if (job.versions?.length) body += `<section class="versions" aria-labelledby="vs-h"><h3 id="vs-h">${t("Versions")}</h3><ol reversed>${[...job.versions].reverse().map((v) => `<li>
    <div><b>v${v.n}</b> <a href="/media/${job.id}/${v.draft}" target="_blank" rel="noopener">${t("Watch")}</a> <span class="muted">${t("{when}, {amount} spent so far", { when: new Date(v.at).toLocaleString("en-IN", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }), amount: rupees(v.spent) })}${v.voice ? `, ${t("voice {voice}", { voice: esc(v.voice) })}` : ""}</span></div>
    <div>${esc(v.note)}${v.request ? ` <span class="muted">${t("(asked: “{request}”)", { request: esc(v.request) })}</span>` : ""}</div>
    ${v.draft !== job.draft && ["draft_review", "done"].includes(job.status) ? `<button type="button" class="quiet" data-act="restore" data-n="${v.n}">${t("Use this version")}</button>` : v.draft === job.draft ? `<span class="ok">${t("Current")}</span>` : ""}
  </li>`).join("")}</ol></section>`;
  // Quality check of the latest draft, and the reasons a person should look closely.
  if (job.critic && job.status !== "script_review") body += `<section class="checks" aria-labelledby="ck-h">
    <h3 id="ck-h">${t("Checks")} ${job.review?.length ? `<span class="rv">${t("Needs a human look")}</span>` : `<span class="ok">${t("Looks clean")}</span>`}</h3>
    <p class="muted" style="margin:0 0 8px">${esc(job.critic.summary)}</p>
    ${job.critic.issues?.length ? `<ul>${job.critic.issues.map((i) => `<li class="${i.severity}">${t("{severity} at {at} s: {problem}", { severity: `<b>${esc(i.severity)}</b>`, at: esc(i.at), problem: esc(i.problem) })}</li>`).join("")}</ul>` : ""}
    ${job.review?.length ? `<p style="margin:10px 0 0">${t("Look at: {list}.", { list: job.review.map(esc).join("; ") })}</p>` : ""}
    ${job.review?.some((r) => / is not in /.test(r)) && ["draft_review", "done"].includes(job.status) ? `<div class="row" style="margin-top:10px"><button type="button" class="quiet" data-act="fix-language" data-confirm="${esc(t("Translate the text that is in another language and repair broken words, then make the draft again? Nothing else in the script changes."))}">${t("Fix the language")}</button></div>` : ""}
  </section>`;
  if (job.subFiles?.length && (job.draft || job.finals?.length) && job.status !== "script_review") body += `<p class="muted" style="margin-top:6px">${t("Subtitle files for YouTube: {list}", { list: job.subFiles.map((l) => `<a href="/media/${job.id}/subtitles/${l}.srt" download>${t("{lang} (SRT)", { lang: LANG[l]?.[1] ?? l })}</a>`).join(", ") })}</p>`;
  body += job.status === "script_review"
    ? `<form id="rewrite"><h3>${t("Rewrite from the source")}</h3>
        <label for="f-source" style="margin-top:0">${t("Source text")}</label><textarea id="f-source" minlength="20" maxlength="20000" required>${esc(job.input)}</textarea>
        <label for="f-brief">${t("Brief")}</label><input id="f-brief" maxlength="500" value="${esc(job.brief)}" placeholder="${esc(t("For example: make it breaking"))}">
        <div class="row"><button type="submit" class="quiet">${t("Rewrite the script")}</button></div></form>`
    : `<h3>${t("Source text")}</h3><div class="source" translate="no">${esc(job.input)}</div>`;
  // Adding or removing a photo re-renders the page: what the editor typed or ticked in the script form stays.
  const old = $("#script")?.dataset.job === job.id ? [...$("#script").elements].filter((e) => e.id).map((e) => [e.id, e.type === "checkbox" || e.type === "radio" ? e.checked : e.value]) : [];
  $("#job-body").innerHTML = body;
  requestAnimationFrame(segFades);
  for (const [id, v] of old) { const e = document.getElementById(id); if (e) e[typeof v === "boolean" ? "checked" : "value"] = v; }
  // Any length is fine: past a field's comfortable size the video sets that text smaller, and a quiet note says so.
  for (const f of document.querySelectorAll("#script [data-fit]")) {
    const note = Object.assign(document.createElement("span"), { className: "count" });
    note.setAttribute("aria-live", "polite");
    const update = () => { note.hidden = f.value.trim().length <= Number(f.dataset.fit); note.textContent = t("Long: it will be set a little smaller in the video to fit."); };
    f.after(note); f.addEventListener("input", update); update();
  }
  renderFacts(job);
  // A story just opened: its sections and details arrive one after another (not on every poll).
  if (job.id !== shownId) {
    shownId = job.id;
    for (const el of [$("#job-body"), $("#facts")]) {
      [...el.children].forEach((c, n) => c.style.setProperty("--n", n));
      el.classList.remove("enter"); void el.offsetWidth; el.classList.add("enter");
    }
  }

  $("#script")?.addEventListener("change", (e) => {
    if (e.target.name !== "tpl") return;
    $("#figure-fields").hidden = e.target.value !== "numbers";
    $("#quote-fields").hidden = e.target.value !== "quote";
  });
  // A kept template choice also brings back its own fields (key figure, quote).
  if (old.length) document.querySelector('input[name="tpl"]:checked')?.dispatchEvent(new Event("change", { bubbles: true }));
  $("#script")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const script = formScript(s);
    const { subLangs, burn } = pickedSubs();
    const who = document.querySelector('input[name="presenter-r"]:checked').value;
    await act(job.id, "approve-script", { script, presenter: who !== "voice", bumpers: $("#f-bumpers").checked, subLangs, burn }, e.submitter);
  });
  $("#revoice")?.addEventListener("submit", (e) => {
    e.preventDefault();
    act(job.id, "revoice", { narration: $("#f-voice-narration").value }, e.submitter);
  });
  $("#ph-input")?.addEventListener("change", async (e) => {
    for (const file of e.target.files) {
      const res = await withSignIn(() => fetch(`/api/jobs/${job.id}/photos`, { method: "POST", headers: { "Content-Type": file.type }, body: file }));
      if (res.status === 401) break; // "Not now" on the sign-in panel
      if (!res.ok) { const msg = (await res.json().catch(() => ({}))).error; alert(msg ? t(msg) : t("Upload failed ({status})", { status: res.status })); break; }
    }
    if (stillOpen(job.id)) show(job.id);
  });
  $("#english-refresh")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = t("Translating…");
    try { $("#english-body").innerHTML = englishHtml((await api(`/api/jobs/${job.id}/english`, { method: "POST", body: JSON.stringify({ script: formScript(s) }) })).english); }
    catch (err) { say(err); }
    btn.disabled = false; btn.textContent = t("Update after my edits");
  });
  if ($("#dl-go")) {
    $("#dl-go").href = dlHref(job.id);
    for (const sel of ["#dl-v", "#dl-q", "#dl-s"]) $(sel).addEventListener("change", () => { $("#dl-go").href = dlHref(job.id); });
  }
  $("#subs-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    if (confirm(t("Make a new final with these subtitles? Earlier versions stay downloadable. Edits made in Studio will be replaced, and new translations are written by Gemini."))) act(job.id, "subtitles", pickedSubs(), e.submitter);
  });
  $("#adjust")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const s = job.script, script = {};
    for (const k of ["category", "headline", "standfirst"]) if ($(`#aj-${k}`).value.trim() !== (s[k] ?? "")) script[k] = $(`#aj-${k}`).value.trim();
    const ticker = $("#aj-ticker").value.split("\n").map((l) => l.trim()).filter(Boolean);
    if (JSON.stringify(ticker) !== JSON.stringify(s.ticker ?? [])) script.ticker = ticker;
    const at = { ...job.cutawayAt }, off = [];
    for (const row of document.querySelectorAll("#adjust [data-file]")) {
      const f = row.dataset.file, v = row.querySelector("input[type=number]").value;
      if (!row.querySelector("input[type=checkbox]").checked) off.push(f);
      if (v === "") delete at[f]; // emptied: placed automatically again
      else if (v !== row.dataset.t) at[f] = Number(v);
    }
    act(job.id, "adjust", { script, at, off }, e.submitter);
  });
  $("#change")?.addEventListener("click", (e) => { const c = e.target.closest(".chip-btn"); if (c) $("#f-change").value = c.textContent; });
  $("#change")?.addEventListener("submit", (e) => {
    e.preventDefault();
    act(job.id, "change", { request: $("#f-change").value }, e.submitter);
  });
  $("#rewrite")?.addEventListener("submit", (e) => {
    e.preventDefault();
    if (confirm(t("Rewrite the script from the source text and brief? Your edits to the current script will be lost."))) act(job.id, "rewrite", { input: $("#f-source").value, brief: $("#f-brief").value }, e.submitter);
  });
}

$("#job").addEventListener("click", async (e) => {
  const id = new URLSearchParams(location.search).get("job");
  const btn = e.target.closest("button");
  if (!btn || !id) return;
  if (btn.dataset.confirm && !confirm(btn.dataset.confirm)) return;
  if (btn.dataset.photo) { btn.disabled = true; await withSignIn(() => fetch(`/api/jobs/${id}/photos/${btn.dataset.photo}`, { method: "DELETE" })); btn.disabled = false; return stillOpen(id) && show(id); }
  if (btn.dataset.copy) { await navigator.clipboard.writeText($(`#pk-${btn.dataset.copy}`).textContent); btn.textContent = t("Copied"); return; }
  if ("convert" in btn.dataset) return act(id, "convert", { presenter: document.querySelector('input[name="tw-pres"]:checked').value !== "voice" }, btn);
  if ("yt" in btn.dataset) { const at = $("#f-yt-at").value; return act(id, "youtube", at ? { publishAt: new Date(at).toISOString() } : {}, btn); }
  if (btn.dataset.act) return act(id, btn.dataset.act, btn.dataset.to ? { to: btn.dataset.to } : btn.dataset.n ? { n: Number(btn.dataset.n) } : btn.dataset.on ? { on: btn.dataset.on === "true" } : {}, btn);
  if ("studio" in btn.dataset) {
    btn.disabled = true; btn.textContent = t("Opening Studio…");
    const tab = window.open("", "_blank");
    try {
      const { url } = await api(`/api/jobs/${id}/studio`, { method: "POST" });
      // Popup blockers (Safari) return null from window.open; fall back to this tab.
      if (tab) tab.location = url; else location.href = url;
    } catch (err) { tab?.close(); say(err); }
    btn.disabled = false; btn.textContent = t("Open in HyperFrames Studio");
  }
});

const stillOpen = (id) => new URLSearchParams(location.search).get("job") === id;
async function act(id, action, payload, btn) {
  if (btn) btn.disabled = true;
  try {
    await api(`/api/jobs/${id}/${action}`, { method: "POST", body: JSON.stringify(payload) });
    if (!stillOpen(id)) return;
    await show(id);
    $("#job-body").focus({ preventScroll: true }); // the clicked button is gone after the re-render
  } catch (err) { say(err); if (btn) btn.disabled = false; }
}

// Pill rows that scroll sideways: fade the side that still has pills, and bring a focused pill into view.
function segFades() {
  for (const s of document.querySelectorAll(".seg")) {
    s.classList.toggle("more-start", s.scrollLeft > 2);
    s.classList.toggle("more-end", s.scrollLeft + s.clientWidth < s.scrollWidth - 2);
  }
}
document.addEventListener("scroll", (e) => { if (e.target.classList?.contains("seg")) segFades(); }, true);
addEventListener("resize", segFades);
document.addEventListener("focusin", (e) => { if (e.target.closest(".seg")) e.target.nextElementSibling?.scrollIntoView({ block: "nearest", inline: "nearest" }); });
segFades();

route();
