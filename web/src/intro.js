import { t, uiLang } from "./i18n.js";

// Intro page: the scrollbar drives the film. The whole video is fetched first so seeking stays local and smooth,
// and the shown time eases toward the scroll position instead of jumping.
const $ = (s) => document.querySelector(s);
const film = $("#film"), screen = $("#screen"), video = $("#video");
const beats = [...document.querySelectorAll(".beat")], marks = [...document.querySelectorAll(".index li")];
const still = matchMedia("(prefers-reduced-motion: reduce)");
// Where each of the five counter marks starts, as a share of the film.
const SECTIONS = [0, 0.2, 0.47, 0.6, 0.72];

let target = 0, shown = 0, duration = 0;
const progress = () => {
  const run = film.offsetHeight - innerHeight;
  return run > 0 ? Math.min(1, Math.max(0, -film.getBoundingClientRect().top / run)) : 0;
};

function onScroll() {
  const p = progress();
  target = p * duration;
  for (const b of beats) b.classList.toggle("on", p >= Number(b.dataset.from) && p < Number(b.dataset.to));
  const at = SECTIONS.findLastIndex((s) => p >= s);
  marks.forEach((m, i) => m.classList.toggle("on", i === at));
  screen.classList.toggle("hero-on", at === 0);
  // Past the film the bar needs its own background, or it sits on the footer text.
  $("header").classList.toggle("solid", film.getBoundingClientRect().bottom < 80);
}

function tick() {
  shown += (target - shown) * 0.12;
  if (Math.abs(target - shown) < 0.001) shown = target;
  if (Math.abs(video.currentTime - shown) > 1 / 60) video.currentTime = shown;
  requestAnimationFrame(tick);
}

async function load() {
  // shortcut: one ~10 s file loaded whole; for longer films switch to an image sequence on a canvas.
  const res = await fetch("/intro/film.mp4");
  if (!res.ok) throw new Error(`film ${res.status}`);
  video.src = URL.createObjectURL(await res.blob());
  await new Promise((ok, fail) => { video.onloadeddata = ok; video.onerror = fail; });
  duration = video.duration;
  screen.classList.add("ready");
  onScroll();
}

const LANG = { en: t("English"), te: t("Telugu"), hi: t("Hindi"), ta: t("Tamil"), kn: t("Kannada"), ml: t("Malayalam"), mr: t("Marathi"), bn: t("Bengali"), gu: t("Gujarati"), or: t("Odia") };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ago = (iso) => { const h = Math.round((Date.now() - Date.parse(iso)) / 36e5); return h < 1 ? t("just now") : h < 24 ? t("{h} h ago", { h }) : t("{d} d ago", { d: Math.round(h / 24) }); };

// The hero monitor plays the newest finished landscape story; the bulletin shows the four newest finished stories.
// The showcase is finished stories only, so visitors who aren't signed in see the same page.
async function broadcasts(done) {
  const wide = done.filter((j) => j.format !== "vertical");
  // The monitor plays a story in the page's language, then English, then the newest of any.
  const lead = wide.find((j) => j.lang === uiLang) ?? wide.find((j) => j.lang === "en") ?? wide[0];
  if (lead) {
    const v = $("#mon-video");
    v.poster = `/media/${lead.id}/poster.jpg`;
    v.src = `/media/${lead.id}/${lead.final}`;
    if (!still.matches) v.play().catch(() => {}); // with reduced motion the still stays
    $("#mon-head").textContent = lead.headline;
    $("#mon-head").lang = lead.lang;
    $("#mon-link").href = `/?job=${lead.id}`;
    $("#mon-meta").textContent = t("{lang}, finished {when}", { lang: LANG[lead.lang] ?? lead.lang, when: ago(lead.updatedAt) });
    $("#monitor").hidden = false;
  } else {
    // Nothing finished yet: the monitor shows what a broadcast looks like, from the templates.
    $("#mon-video").poster = "/templates/vt03-breaking.jpg";
    $("#mon-head").textContent = t("Your first finished story plays here");
    $("#mon-link").href = "/#desk";
    $("#mon-meta").textContent = t("Breaking template");
    $("#monitor").hidden = false;
  }
  // A bulletin runs each story once, in landscape, newest first. With fewer than two different stories, it shows the
  // same story in different languages (what the studio does); with none finished, the templates a bulletin is made of.
  const first = [...wide.filter((j) => j.lang === uiLang), ...wide.filter((j) => j.lang !== uiLang)]; // the page's language leads
  const pick = (key) => { const seen = new Set(); return first.filter((j) => !seen.has(key(j)) && seen.add(key(j))).slice(0, 4); };
  const stories = pick((j) => j.group ?? j.id), langs = pick((j) => j.lang);
  const bulletin = stories.length >= 2 ? stories : langs.length >= 2 ? langs : [];
  $("#rundown").innerHTML = bulletin.length
    ? bulletin.map((j, i) => `<li><a href="/?job=${j.id}">
      <span class="still"><img src="/media/${j.id}/poster.jpg" alt="" loading="lazy"><span class="no">${i + 1}</span></span>
      <b lang="${esc(j.lang)}">${esc(j.headline)}</b><small>${esc(LANG[j.lang] ?? j.lang)}</small></a></li>`).join("")
    : [["vt01-lead-desk", "Lead Desk"], ["vt03-breaking", "Breaking"], ["vt04-numbers-desk", "Numbers Desk"], ["vt06-key-points", "Key Points"]].map(([file, name], i) => `<li><a href="/#templates">
      <span class="still"><img src="/templates/${file}.jpg" alt="" loading="lazy"><span class="no">${i + 1}</span></span>
      <b>${esc(t(name))}</b><small>${esc(t("Template"))}</small></a></li>`).join("");
  $("#rundown").hidden = false;
  // The turn: the newest finished story that started as a wire release, shown as release then headline.
  const wired = done.filter((j) => j.sourceTitle && j.sourceTitle !== j.headline);
  const turned = wired.find((j) => j.lang !== "en") ?? wired[0]; // another language shows the change best
  if (turned) {
    $("#turn-src").textContent = t("{source} release", { source: turned.sourceName ?? t("Verified wire") });
    $("#turn-in").textContent = turned.sourceTitle;
    $("#turn-out").textContent = turned.headline;
    $("#turn-out").lang = turned.lang;
    $("#turn-lang").textContent = LANG[turned.lang] ?? turned.lang;
    $("#turn-link").href = `/?job=${turned.id}`;
    $("#b-turn").hidden = false;
  }
}

// The wire: the latest verified releases, as the studio's inbox has them.
async function wire(tries = 6) {
  const { items, translating } = await (await fetch(`/api/inbox?lang=${uiLang}`)).json();
  if (translating && tries > 1) setTimeout(() => wire(tries - 1).catch(() => {}), 8000); // headlines still being translated
  if (!items?.length) return;
  $("#feed").innerHTML = items.slice(0, 6).map((it, n) => `<li style="--n:${n}"><a href="/#inbox"><span>${esc(it.sourceName)}</span><p>${esc(it.title)}</p></a></li>`).join("");
  $("#b-feed").hidden = false;
}

// The stats card shows the studio's real rundown; if it can't be read, the card keeps its dash.
async function stats() {
  const { done, drafted, signedIn } = await (await fetch("/api/stats")).json();
  fetch("/api/showcase").then((r) => r.json()).then(broadcasts).catch(() => {});
  // Not signed in yet: the way in is signing in, or making an account.
  if (!signedIn) {
    Object.assign($("#top-cta"), { href: "/login", textContent: t("Sign in") });
    Object.assign($("#end-cta"), { href: "/signup", textContent: t("Create an account") });
  }
  // Measured against stories that reached a draft: filed-then-abandoned tests would make the bar mean nothing.
  $("#st-done").textContent = done;
  $("#st-bar").style.width = `${drafted ? Math.round((done / drafted) * 100) : 0}%`;
  $("#st-note").textContent = t("{done} of {drafted} drafted stories finished", { done, drafted });
}

addEventListener("scroll", onScroll, { passive: true });
addEventListener("resize", onScroll);
onScroll();
stats().catch(() => {});
wire().catch(() => {});
// With reduced motion the poster stays and nothing moves; if the film fails to load, the poster stays too.
if (!still.matches) load().then(() => requestAnimationFrame(tick)).catch((e) => console.warn("Intro film not loaded:", e.message));
