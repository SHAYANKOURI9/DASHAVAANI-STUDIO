import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { z } from "zod";
import { lintCss } from "./designer.mjs";
import { unsupportedNumbers, backTargets, Script, fillVariables, templateFor, savePhoto, cutawayMarkup, slateMarkup, projectDir, toWords, captionLines, captionMarkup, addCost, monthSpend, spendByAccount, voiceFor, useKeys, partialScript, sceneCuts, clipStart, sentences, translatedLines, subtitlePlan, cueFiles, gemini, reviewReasons, cutawaySchedule, PublishPack, downloadArgs, findBeat, beatOf, onBeats } from "./pipeline.mjs";

test("fills variables in both single-quoted and Studio-saved templates", () => {
  const single = `<html data-composition-variables='[{"id":"headline","default":"Old"}]'>`;
  const studio = `<html data-composition-variables="[{&quot;id&quot;:&quot;headline&quot;,&quot;default&quot;:&quot;Old&quot;}]">`;
  for (const html of [single, studio]) {
    const out = fillVariables(html, { headline: `Rain "alert" & 'flood'` });
    const json = out.match(/data-composition-variables="([^"]*)"/)[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    assert.equal(JSON.parse(json)[0].default, `Rain "alert" & 'flood'`);
  }
});

const base = { template: "lead", category: "NEWS", headline: "H", standfirst: "", dateline_city: "", narration: "N", ticker: [] };
test("numbers template needs a figure; other templates do not", () => {
  assert.equal(Script.safeParse(base).success, true);
  assert.equal(Script.safeParse({ ...base, template: "numbers" }).success, false);
  assert.equal(Script.safeParse({ ...base, template: "numbers", figure_value: "6.5%", figure_label: "REPO RATE" }).success, true);
  assert.equal(Script.safeParse({ ...base, template: "weather" }).success, false);
});

test("key figure is fact-checked too", () => {
  assert.deepEqual(unsupportedNumbers({ ...base, figure_value: "7.25%" }, "Rate stays at 6.5%"), ['Number "7.25" is not in the source text']);
});

test("back reaches every earlier review stop that has its work", () => {
  const made = { script: {}, voice: "v", draft: "d.mp4" };
  assert.deepEqual(backTargets({ ...made, status: "draft_review" }), ["script_review", "voice_review"]);
  assert.deepEqual(backTargets({ ...made, status: "done" }), ["script_review", "voice_review", "draft_review"]);
  assert.deepEqual(backTargets({ ...made, status: "voice_review" }), ["script_review"]);
  assert.deepEqual(backTargets({ script: {}, status: "error", error: "voice: Sarvam 500" }), ["script_review"]);
  assert.deepEqual(backTargets({ ...made, status: "error", error: "avatar: HeyGen failed" }), ["script_review", "voice_review", "draft_review"]);
  assert.deepEqual(backTargets({ status: "error", error: "script: Claude declined" }), []);
  assert.deepEqual(backTargets({ ...made, status: "voice" }), []); // no going back while a step runs
});

test("flags numbers missing from the source, ignores commas", () => {
  const script = { headline: "Repo rate at 6.5%", standfirst: "", narration: "Loans of 10,000 crore and 7 banks", ticker: [] };
  assert.deepEqual(unsupportedNumbers(script, "The repo rate is 6.5%. Loans worth 10000 crore."), ['Number "7" is not in the source text']);
});

test("vertical stories use the Shorts layout whatever template the script picked", () => {
  assert.match(templateFor({ format: "vertical", script: { template: "breaking" } }), /vt05-shorts$/);
  assert.match(templateFor({ script: { template: "breaking" } }), /vt03-breaking$/); // older stories have no format
});

test("photos: only images and clips, one copy each, at most six", async () => {
  const job = { id: `test-photos-${process.pid}` };
  const jpg = (x) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(x)]), png = (x) => Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.from(x)]);
  try {
    await assert.rejects(savePhoto(job, Buffer.from("x"), "text/html", "Uploaded"), /JPEG, PNG or WebP/);
    await assert.rejects(savePhoto(job, Buffer.from("<html><script>alert(1)</script>"), "image/jpeg", "Uploaded"), /not a JPEG/, "the bytes decide, not the label");
    assert.equal(fs.existsSync(projectDir(job)) ? fs.readdirSync(`${projectDir(job)}/assets/photos`).length : 0, 0, "nothing left behind");
    assert.equal(job.photos, undefined);
    await savePhoto(job, Buffer.from("RIFF\0\0\0\0WEBPVP8 "), "image/webp", "Uploaded");
    await savePhoto(job, jpg("a"), "image/jpeg", "PIB");
    await savePhoto(job, jpg("a"), "image/jpeg", "Uploaded"); // same picture again
    assert.equal(job.photos.length, 2);
    for (let i = 0; i < 4; i++) await savePhoto(job, png(`b${i}`), "image/png", "Uploaded");
    await assert.rejects(savePhoto(job, png("c"), "image/png", "Uploaded"), /at most 6/);
    await assert.rejects(savePhoto({ id: `${job.id}-clip` }, Buffer.from("not a video"), "video/mp4", "Uploaded"), /could not be read/);
    assert.equal(fs.readdirSync(`${projectDir({ id: `${job.id}-clip` })}/assets/photos`).length, 0, "a bad clip leaves no files");
  } finally { for (const id of [job.id, `${job.id}-clip`]) fs.rmSync(projectDir({ id }), { recursive: true, force: true }); }
});

test("cutaways escape the headline and keep their script separate", () => {
  const [markup, script] = cutawayMarkup([{ file: "a.jpg" }], { category: "NEWS", headline: `<img onerror="x">`, vertical: true }).split("<!--script-->");
  assert.match(markup, /&lt;img onerror=&quot;x&quot;&gt;/);
  assert.match(markup, /class="v"/);
  assert.match(script, /__timelines\.main/);
});

test("voice-only slate: photos become a slideshow, otherwise a title card", () => {
  assert.equal((slateMarkup([{ file: "a.jpg" }, { file: "b.jpg" }], { category: "NEWS" }).match(/class="slide"/g) ?? []).length, 2);
  const card = slateMarkup([], { category: "<b>" });
  assert.match(card, /class="card"/);
  assert.match(card, /&lt;b&gt;/);
});

test("words come from ElevenLabs character timings, spaces dropped", () => {
  const characters = [..."Hi all."];
  const words = toWords({ characters, character_start_times_seconds: characters.map((_, i) => i / 10), character_end_times_seconds: characters.map((_, i) => (i + 1) / 10) });
  assert.deepEqual(words, [{ w: "Hi", s: 0, e: 0.2 }, { w: "all.", s: 0.3, e: 0.7 }]);
});

test("caption lines break after punctuation and at five words", () => {
  const w = (t) => ({ w: t, s: 0, e: 0 });
  const lines = captionLines("Rain hits city. One two three four five six".split(" ").map(w)).map((l) => l.map((x) => x.w).join(" "));
  assert.deepEqual(lines, ["Rain hits city.", "One two three four five", "six"]);
  const commas = captionLines("Oh, the trains run, every three minutes".split(" ").map(w)).map((l) => l.map((x) => x.w).join(" "));
  assert.deepEqual(commas, ["Oh, the trains run,", "every three minutes"]);
  assert.match(captionMarkup([[{ w: "<b>", s: 0, e: 1 }]], { vertical: false, lang: "te", highlight: true }), /&lt;b&gt;/);
});

test("cost adds up per part, and the month sums this month's stories only", () => {
  const job = { createdAt: "2026-10-13T10:00:00Z" };
  addCost(job, "voice", 373, 5.595);
  addCost(job, "voice", 100, 1.5);
  assert.deepEqual(job.cost.voice, { units: 473, inr: 7.1 });
  const old = { createdAt: "2026-09-30T10:00:00Z", cost: { voice: { units: 1, inr: 99 } } };
  assert.deepEqual(monthSpend([job, old, { createdAt: "2026-10-14T10:00:00Z" }], new Date("2026-10-20")), { stories: 1, script: 0, voice: 7.1, presenter: 0, total: 7.1 });
});

test("translated subtitles keep each sentence's time span", () => {
  const words = [{ w: "Rain", s: 0, e: 0.5 }, { w: "today.", s: 0.5, e: 1 }, { w: "Roads", s: 1.2, e: 1.6 }, { w: "shut.", s: 1.6, e: 2 }];
  const spans = sentences(words);
  assert.deepEqual(spans.map((x) => [x.text, x.s, x.e]), [["Rain today.", 0, 1], ["Roads shut.", 1.2, 2]]);
  const lines = translatedLines(spans, ["ఈరోజు వర్షం.", "రోడ్లు మూసివేత."]);
  assert.equal(lines.length, 2);
  assert.equal(lines[1][0].s, 1.2);
  assert.ok(Math.abs(lines[1].at(-1).e - 2) < 1e-9);
  assert.doesNotMatch(captionMarkup(lines, { vertical: false, lang: "te", highlight: false }), /if \(true\)/);
});

test("quote and key points templates need their own fields", () => {
  const full = { ...base, ticker: ["ONE", "TWO"], quote_text: "Water for all", quote_by: "CM" };
  assert.equal(Script.safeParse({ ...full, template: "quote" }).success, true);
  assert.equal(Script.safeParse({ ...full, template: "quote", quote_by: "" }).success, false);
  assert.equal(Script.safeParse({ ...full, template: "points" }).success, true);
  assert.equal(Script.safeParse({ ...full, template: "points", ticker: ["ONE"] }).success, false);
  assert.match(templateFor({ script: { template: "photo" } }), /vt08-photo-story$/);
});

test("subtitle plan: older stories keep their single choice", () => {
  assert.deepEqual(subtitlePlan({ lang: "te" }), { langs: ["te"], burn: "te" });
  assert.deepEqual(subtitlePlan({ lang: "te", subs: "off" }), { langs: [], burn: "off" });
  assert.deepEqual(subtitlePlan({ lang: "te", subLangs: ["te", "en"], burn: "off" }), { langs: ["te", "en"], burn: "off" });
});

test("SRT and VTT cues: numbered, comma vs dot, ending at the next cue or a second after the last word", () => {
  const { srt, vtt } = cueFiles([[{ w: "Rain", s: 0, e: 0.4 }, { w: "today.", s: 0.4, e: 0.9 }], [{ w: "Roads", s: 5, e: 5.5 }]]);
  assert.equal(srt, "1\n00:00:00,000 --> 00:00:01,900\nRain today.\n\n2\n00:00:05,000 --> 00:00:06,500\nRoads\n");
  assert.match(vtt, /^WEBVTT\n\n00:00:00\.000 --> 00:00:01\.900\nRain today\./);
});


test("gemini: a hang and a busy answer are retried, falling back to the lighter model", async () => {
  const real = globalThis.fetch, seen = [];
  Object.assign(process.env, { GEMINI_API_KEY: "test", GEMINI_RETRY_MS: "1" });
  const ok = { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"lines":["a"]}' }] } }], usageMetadata: { totalTokenCount: 5 } }) };
  const answers = [() => { throw Object.assign(new Error("hung"), { name: "TimeoutError" }); }, () => ({ status: 503 }), () => ok];
  globalThis.fetch = async (url) => { seen.push(url.match(/models\/([^:]+)/)[1]); return answers[seen.length - 1](); };
  try {
    const job = {};
    assert.deepEqual(await gemini(job, "sys", "hi", z.object({ lines: z.array(z.string()) }), "test"), { lines: ["a"] });
    assert.deepEqual(seen, ["gemini-flash-latest", "gemini-flash-latest", "gemini-flash-lite-latest"]);
    assert.equal(job.cost.script.units, 5);
    globalThis.fetch = async () => ({ status: 503 });
    await assert.rejects(gemini({}, "sys", "hi", z.object({}), "test"), /busy or not answering/);
  } finally { globalThis.fetch = real; delete process.env.GEMINI_RETRY_MS; }
});

test("review reasons: unsupported numbers, serious frame faults and translated subtitles; low faults are fine", () => {
  assert.deepEqual(reviewReasons({}), []);
  const r = reviewReasons({ lang: "te", warnings: ['Number "7" is not in the source text'], subFiles: ["te", "en"],
    critic: { issues: [{ at: 4, severity: "high", problem: "Headline cut off" }, { at: 9, severity: "low", problem: "Ticker tight" }] } });
  assert.deepEqual(r, ['Number "7" is not in the source text', "Headline cut off (at 4 s)", "Translated subtitles need a read"]);
});

test("cutaway schedule: evenly spaced, moved to a nearby sentence start, clips no longer than they run", () => {
  const w = (t, s) => ({ w: t, s, e: s + 0.4 });
  const words = [w("One.", 0), w("Two", 4.5), w("words.", 4.9), w("Three.", 9), w("Four.", 14), w("Five.", 18)];
  const sched = cutawaySchedule({ seconds: 22, words }, [{ file: "a.jpg" }, { file: "b.mp4", kind: "clip", seconds: 2 }]);
  assert.equal(sched.length, 2);
  assert.ok(sched[0].snapped && sched[0].t === 4.5, `photo moved to the sentence starting at 4.5 s, got ${sched[0].t}`);
  assert.equal(sched[1].show, 2); // the clip is only 2 s long
  assert.ok(sched[1].t >= sched[0].t + sched[0].show, "no overlap");
  assert.equal(cutawaySchedule({ seconds: 5 }, [{ file: "a.jpg" }]).length, 0); // too short for a cutaway
});

test("template designer brand check: house colours only, nothing loaded, disclosure stays visible", () => {
  assert.deepEqual(lintCss("#root #headline { color: #f0a202; font-size: 90px; } #root #badge { background: rgba(201, 48, 26, .9); }"), []);
  assert.match(lintCss("#root #headline { color: #ff00ff; }").join(), /not a Dashavani colour/);
  assert.match(lintCss("#root #headline { color: purple; }").join(), /colour names/);
  assert.match(lintCss("#root #story { background: url(http://x/y.png); }").join(), /may not load/);
  assert.match(lintCss("#root #disclosure { display: none; }").join(), /must stay visible/);
  assert.deepEqual(lintCss("#root #badge, #root #face { opacity: .9; }"), []); // ids that look like hex are not colours
});

test("publish pack keeps to platform limits", () => {
  const ok = { youtube_title: "T", youtube_description: "D", tags: ["rbi"], hashtags: ["#RBI"], instagram_caption: "C", x_post: "X" };
  assert.equal(PublishPack.safeParse(ok).success, true);
  assert.equal(PublishPack.safeParse({ ...ok, x_post: "x".repeat(281) }).success, false);
  assert.equal(PublishPack.safeParse({ ...ok, youtube_title: "t".repeat(101) }).success, false);
  assert.equal(PublishPack.safeParse({ ...ok, hashtags: ["RBI"] }).success, false);
});

test("downloads: copy at original size, scale the short side, pick subtitle tracks by language", () => {
  const a = (...x) => downloadArgs("in.mp4", "out.mp4", ...x).join(" ");
  assert.match(a("original", "none", false), /-c:v copy/);
  assert.doesNotMatch(a("original", "none", false), /0:s/);
  assert.match(a("720", "all", false), /scale=-2:720 .*-map 0:s\?|-map 0:s\? .*scale=-2:720/);
  assert.match(a("480", 1, true), /scale=480:-2/);
  assert.match(a("480", 1, true), /-map 0:s:1 /);
});

test("a number inside a bigger source number is still flagged", () => {
  assert.deepEqual(unsupportedNumbers({ ...base, narration: "Toll is 5" }, "Toll is 15"), ['Number "5" is not in the source text']);
  assert.deepEqual(unsupportedNumbers({ ...base, narration: "₹2 crore" }, "a ₹12.50 crore budget"), ['Number "2" is not in the source text']);
});

test("digits written in Indian scripts are checked too", () => {
  assert.equal(unsupportedNumbers({ ...base, narration: "మృతుల సంఖ్య ౫౦" }, "Death toll 12").length, 1, "Telugu");
  assert.equal(unsupportedNumbers({ ...base, narration: "५० लोग" }, "Death toll 12").length, 1, "Hindi");
  assert.equal(unsupportedNumbers({ ...base, narration: "௫௦ பேர்" }, "Death toll 50").length, 0, "Tamil 50 matches 50");
  assert.equal(unsupportedNumbers({ ...base, narration: "৫০ জন" }, "Death toll 50").length, 0, "Bengali 50 matches 50");
});

test("cutaways never overlap, even when an earlier one snapped later", () => {
  const words = [{ w: "Start.", s: 0, e: 1 }, { w: "One.", s: 4.9, e: 5.5 }, { w: "Two", s: 7, e: 7.5 }, { w: "end.", s: 7.6, e: 8 }, { w: "x", s: 12, e: 12.5 }, { w: "y.", s: 19, e: 19.5 }];
  const s = cutawaySchedule({ seconds: 20, words }, [1, 2, 3, 4, 5, 6].map((i) => ({ file: `${i}.jpg` })));
  for (let i = 1; i < s.length; i++) assert.ok(s[i].t >= s[i - 1].t + s[i - 1].show, `cut ${i} starts at ${s[i].t}, before cut ${i - 1} ends at ${s[i - 1].t + s[i - 1].show}`);
  for (const c of s) assert.ok(c.t + c.show <= 20 - 0.5, "every cut ends before the video does");
});

test("this month means this month in India", () => {
  const job = { cost: { script: { inr: 5 } }, createdAt: "2026-09-30T20:30:00.000Z" }; // 1 Oct, 02:00 IST
  assert.equal(monthSpend([job], new Date("2026-10-20T06:00:00.000Z")).stories, 1);
});

test("a closing quote after the full stop still ends the sentence", () => {
  const ws = ["He", "said", '"we', 'won."', "Next", "one."].map((w, i) => ({ w, s: i, e: i + 0.5 }));
  assert.equal(sentences(ws).length, 2);
  assert.equal(captionLines(ws)[0].at(-1).w, 'won."');
});

test("brand check also catches space-separated rgb and a hidden AI label with !important", () => {
  assert.match(lintCss("#root #headline { color: rgb(255 0 0); }").join(), /not a Dashavani colour/);
  assert.match(lintCss("#root #disclosure { opacity: 0 !important; }").join(), /must stay visible/);
  assert.deepEqual(lintCss("#root #badge { background: rgb(240 162 2 / .9); }"), [], "the house gold in the new syntax is fine");
});

test("a look still being made cannot be rejected out from under the designer", async () => {
  const { setStatus } = await import("./designer.mjs");
  const id = "c-0000beef", dir = `data/custom-templates/${id}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/custom.json`, JSON.stringify({ id, status: "making" }));
  try {
    assert.match(setStatus(id, "rejected") ?? "", /still being made/);
    assert.ok(fs.existsSync(dir), "folder kept");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("script problems are said in plain words, with the length now", async () => {
  const { scriptProblems } = await import("./pipeline.mjs");
  const long = "x".repeat(214);
  assert.deepEqual(scriptProblems({ ...base, template: "quote", quote_text: long, quote_by: "PM" }), [], "long text is never a problem: the video sets it smaller");
  assert.deepEqual(scriptProblems({ ...base, headline: "x".repeat(300), ticker: ["y".repeat(120), "a", "b", "c", "d", "e", "f"] }), []);
  assert.deepEqual(scriptProblems({ ...base, headline: "" }), ["Headline: can't be empty"]);
  assert.deepEqual(scriptProblems({ ...base, template: "quote" }), ["Quote needs the exact words and who said them"]);
  assert.deepEqual(scriptProblems(base), []);
});

test("a script missing a required piece goes back to the writer once; text is never cut", async () => {
  const { fixScript } = await import("./pipeline.mjs");
  const bad = { ...base, template: "quote", quote_text: "q".repeat(400), quote_by: "" };
  const asked = [];
  const good = await fixScript(bad, async (problems) => { asked.push(problems); return { ...bad, quote_by: "PM" }; });
  assert.equal(good.script.quote_text.length, 400, "the quote stays exactly as written");
  assert.deepEqual(good.problems, []);
  assert.deepEqual(asked, [["Quote needs the exact words and who said them"]]);
  const fine = await fixScript({ ...bad, quote_by: "PM" }, async () => { throw new Error("should not be asked"); });
  assert.deepEqual(fine.problems, []);
});

test("long text is set smaller in the video, in proportion, never below about half", async () => {
  const { fitStyles } = await import("./pipeline.mjs");
  assert.equal(fitStyles({ ...base, headline: "h".repeat(90) }), "", "within the comfortable length: untouched");
  assert.match(fitStyles({ ...base, template: "quote", quote_text: "q".repeat(200), quote_by: "PM" }), /#quote \{ zoom: 0\.8; \}/);
  assert.match(fitStyles({ ...base, headline: "h".repeat(900) }), /#headline \{ zoom: 0\.45; \}/, "floor");
  assert.match(fitStyles({ ...base, ticker: ["a", "p".repeat(120)] }), /\.point p \{ zoom: 0\.5; \}/, "the longest point decides");
});

test("fields a template doesn't use are cleared before the rules are checked", async () => {
  const { dropUnused, scriptProblems } = await import("./pipeline.mjs");
  const long = "q".repeat(200);
  const lead = dropUnused({ ...base, template: "lead", quote_text: long, quote_by: "PM", figure_value: "123456789012345678" });
  assert.equal(lead.quote_text, ""); assert.equal(lead.quote_by, ""); assert.equal(lead.figure_value, "");
  assert.deepEqual(scriptProblems(lead), [], "a long quote no longer blocks a Lead Desk story");
  const quote = dropUnused({ ...base, template: "quote", quote_text: "Short words.", quote_by: "PM", figure_value: "6.5%" });
  assert.equal(quote.quote_text, "Short words.", "a Quote story keeps its quote");
  assert.equal(quote.figure_value, "");
  assert.equal(dropUnused({ ...base, template: "numbers", figure_value: "6.5%", figure_label: "RATE" }).figure_value, "6.5%");
});

test("on-screen text must be in the story's own script; English names and acronyms are fine", async () => {
  const { scriptMismatches } = await import("./pipeline.mjs");
  const te = { ...base, headline: "నవరాత్రులలో మోదీ పూజలు", standfirst: "PIB ప్రకారం", narration: "కథనం", ticker: ["మోదీ GST"], quote_text: "नवरात्रि में आज देवी माता", quote_by: "నరేంద్ర మోదీ", category: "జాతీయం" };
  assert.deepEqual(scriptMismatches(te, "te"), ["Quote is not in Telugu"]);
  assert.deepEqual(scriptMismatches({ ...te, quote_text: "నవరాత్రి సందర్భంగా" }, "te"), []);
  assert.deepEqual(scriptMismatches({ ...base, headline: "प्रधानମନ୍ତ୍ରୀ ନରେନ୍ଦ୍ର" }, "or"), ["Headline is not in Odia"], "a stray Hindi word in an Odia headline");
  assert.deepEqual(scriptMismatches({ ...base, headline: "मुंबईत नवीन मेट्रो" }, "mr"), [], "Marathi is written in Devanagari");
  assert.deepEqual(scriptMismatches({ ...base, quote_text: "నవరాత్రి" }, "en"), ["Quote is not in English"]);
  assert.deepEqual(scriptMismatches(base, "en"), []);
});

test("the fix-up pass also sends wrong-language fields back", async () => {
  const { fixScript, scriptMismatches, scriptProblems } = await import("./pipeline.mjs");
  const bad = { ...base, template: "quote", quote_text: "नवरात्रि में आज", quote_by: "మోదీ", headline: "మోదీ", category: "జాతీయం", narration: "కథనం", standfirst: "" };
  const check = (s) => [...scriptProblems(s), ...scriptMismatches(s, "te")];
  const asked = [];
  const out = await fixScript(bad, async (p) => { asked.push(p); return { ...bad, quote_text: "నవరాత్రిలో ఈరోజు" }; }, check);
  assert.deepEqual(asked, [["Quote is not in Telugu"]]);
  assert.equal(out.script.quote_text, "నవరాత్రిలో ఈరోజు");
  assert.deepEqual(out.problems, []);
});

test("a story interrupted while queued can still go back, judged by the step it was waiting for", () => {
  const job = { status: "error", error: "queued: interrupted by a server restart", pending: { steps: ["final"], after: "done" }, script: base, voice: "v.wav", draft: "draft-v1.mp4" };
  assert.deepEqual(backTargets(job), ["script_review", "voice_review", "draft_review"]);
  assert.deepEqual(backTargets({ ...job, pending: { steps: ["voice", "compose", "draft"], after: "draft_review" }, voice: undefined, draft: undefined }), ["script_review"]);
});

test("a word slipped into another script mid-way is mapped letter by letter into the story's script", async () => {
  const { fixMixedScript } = await import("./pipeline.mjs");
  const gu = fixMixedScript({ ...base, headline: "વડાપ્રધાને માં કૂष्माંડાની પૂજા કરી", narration: "PM મોદી GST" }, "gu");
  assert.equal(gu.headline, "વડાપ્રધાને માં કૂષ્માંડાની પૂજા કરી");
  assert.equal(gu.narration, "PM મોદી GST", "English names and acronyms stay");
  assert.equal(fixMixedScript({ ...base, narration: "ಅसीम ಶಕ್ತಿ" }, "kn").narration, "ಅಸೀಮ ಶಕ್ತಿ");
  const whole = "नवरात्रि में आज";
  assert.equal(fixMixedScript({ ...base, quote_text: whole }, "te").quote_text, whole, "a sentence wholly in another language needs translating, not letter mapping");
  assert.deepEqual(fixMixedScript({ ...base, ticker: ["మోदी"] }, "te").ticker, ["మోదీ"]);
  assert.equal(fixMixedScript({ ...base, headline: "मुंबईत" }, "en").headline, "मुंबईत", "English stories are left to the checks");
});

test("fields wholly in another language are found for translating", async () => {
  const { foreignFields } = await import("./pipeline.mjs");
  assert.deepEqual(foreignFields({ ...base, headline: "మోదీ", quote_text: "नवरात्रि में आज", ticker: ["మోదీ", "देवी माता"] }, "te"), [["quote_text"], ["ticker", 1]]);
  assert.deepEqual(foreignFields({ ...base, headline: "మోదీ PIB" }, "te"), []);
});

test("the owner's spend split: each account's stories add up, old stories are the owner's", () => {
  const c = (inr) => ({ script: { inr }, voice: { inr: 0 }, presenter: { inr: 0 } });
  const jobs = [{ createdAt: "2026-10-02T00:00:00Z", cost: c(1) }, { createdBy: "o", createdAt: "2026-10-03T00:00:00Z", cost: c(2) }, { createdBy: "a", createdAt: "2026-10-04T00:00:00Z", cost: c(4) }, { createdBy: "b", createdAt: "2026-10-04T00:00:00Z" }];
  const split = spendByAccount(jobs, "o", new Date("2026-10-20"));
  assert.deepEqual(split.map((a) => [a.id, a.total]), [["o", 3], ["a", 4]], "an account with no paid story this month is left out");
  assert.equal(split.reduce((n, a) => n + a.total, 0), monthSpend(jobs, new Date("2026-10-20")).total);
});

test("voices come from the server's .env.local for every account", () => {
  process.env.ELEVENLABS_VOICE_TE = "OwnerVoice0000000000";
  try {
    for (const owner of [true, false]) assert.equal(useKeys.run({ owner }, () => voiceFor("te")), "OwnerVoice0000000000");
    assert.equal(voiceFor("hi"), "nPczCjzI2devNBz1zQrb", "a language without one gets the built-in voice");
  } finally { delete process.env.ELEVENLABS_VOICE_TE; }
});

test("live script: the headline and narration read from a reply that is still arriving", () => {
  assert.deepEqual(partialScript('{"template":"lead","headline":"Rain al'), { headline: "Rain al", narration: "" });
  assert.deepEqual(partialScript('{"headline":"A \\"big\\" day","narration":"First line.\\nSecond'), { headline: 'A "big" day', narration: "First line.\nSecond" });
  assert.equal(partialScript('{"narration":"ends on a half escape \\').narration, "ends on a half escape ");
  assert.equal(partialScript('{"narration":"half a unicode \\u0c1').narration, "half a unicode ");
  assert.equal(partialScript('{"narration":"a real backslash \\\\').narration, "a real backslash \\");
  assert.equal(partialScript('{"narration":"తెలుగు వార్త').narration, "తెలుగు వార్త");
  assert.deepEqual(partialScript(""), { headline: "", narration: "" });
});

test("gemini streams: pieces reach onText as they arrive, and the whole reply is still checked", async () => {
  const real = globalThis.fetch, seen = [], urls = [];
  process.env.GEMINI_API_KEY = "test";
  const sse = ['{"lines":["he', 'llo"]}'].map((text, i) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], ...(i === 1 && { usageMetadata: { totalTokenCount: 7 } }) })}\r\n\r\n`);
  globalThis.fetch = async (url) => { urls.push(url); return new Response(new ReadableStream({ start(c) { for (const s of sse) c.enqueue(new TextEncoder().encode(s)); c.close(); } }), { status: 200 }); };
  try {
    const job = {};
    assert.deepEqual(await gemini(job, "sys", "hi", z.object({ lines: z.array(z.string()) }), "test", (t) => seen.push(t)), { lines: ["hello"] });
    assert.deepEqual(seen, ['{"lines":["he', '{"lines":["hello"]}']);
    assert.match(urls[0], /:streamGenerateContent\?alt=sse$/);
    assert.equal(job.cost.script.units, 7, "the cost comes from the last piece");
  } finally { globalThis.fetch = real; }
});

test("shot changes: read from ffmpeg's report, and a cutaway starts on one that leaves it enough to show", async () => {
  const report = "[Parsed_showinfo_1 @ 0x1] n:   0 pts:  48000 pts_time:2.0 duration:512\n[Parsed_showinfo_1 @ 0x1] n:   1 pts: 112640 pts_time:4.4 duration:512\nframe= 3 fps=0.0";
  assert.deepEqual(sceneCuts(report), [2, 4.4]);
  assert.deepEqual(sceneCuts("nothing here"), []);
  const clip = { kind: "clip", seconds: 8, cuts: [0.1, 2, 4.4, 7.5] };
  assert.equal(clipStart(clip, 3), 2, "the first clean cut with 3 s left after it (0.1 s is the opening frame)");
  assert.equal(clipStart(clip, 5), 2);
  assert.equal(clipStart(clip, 6.5), 0, "no cut leaves enough: from the start");
  assert.equal(clipStart({ kind: "clip", seconds: 8 }, 3), 0, "clips saved before this have no cuts");
  // A real clip: 2.5 s of red, then 2.5 s of blue. ffmpeg finds the change at 2.5 s.
  const { savePhoto, projectDir } = await import("./pipeline.mjs");
  const { execFileSync } = await import("node:child_process");
  const job = { id: `test-cuts-${process.pid}` }, src = `/tmp/dv-cuts-${process.pid}.mp4`;
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=red:s=320x240:d=2.5:r=25", "-f", "lavfi", "-i", "color=blue:s=320x240:d=2.5:r=25", "-filter_complex", "[0][1]concat=n=2:v=1", "-pix_fmt", "yuv420p", src]);
  try {
    await savePhoto(job, fs.readFileSync(src), "video/mp4", "Uploaded");
    assert.equal(job.photos[0].cuts.length, 1);
    assert.ok(Math.abs(job.photos[0].cuts[0] - 2.5) < 0.1, `cut at ${job.photos[0].cuts[0]}`);
    const [markup] = cutawayMarkup(job.photos.map((p) => ({ ...p, t: 4, show: 2 })), { category: "NEWS", headline: "H", vertical: false }).split("<!--script-->");
    assert.match(markup, new RegExp(`data-playback-start="${job.photos[0].cuts[0]}"`), "the cutaway plays from the clean cut");
  } finally { fs.rmSync(projectDir(job), { recursive: true, force: true }); fs.rmSync(src, { force: true }); }
});

test("beats: the tempo and where the beats fall, found in the music itself", () => {
  const rate = 8000, clicks = (period, phase, secs) => {
    const a = new Float32Array(rate * secs);
    for (let t = phase; t < secs; t += period) for (let k = 0; k < 200; k++) a[Math.round(t * rate) + k] = Math.sin(k / 3) * Math.exp(-k / 40);
    return a;
  };
  for (const [period, phase] of [[0.5, 0], [0.6, 0.2], [0.42, 0.31]]) {
    const b = findBeat(clicks(period, phase, 20), rate);
    assert.ok(Math.abs(b.period - period) <= 0.011, `period ${b.period} for ${period}`);
    assert.ok(Math.abs(b.phase - phase) <= 0.021, `phase ${b.phase} for ${phase}`);
  }
});

test("beats: each story is held just long enough that the cut after it lands on a beat, never trimmed", () => {
  const beat = { period: 0.5, phase: 0.1 }, near = (a, b) => Math.abs(a - b) < 1e-9; // 7.23 s is 217 frames at 30 fps
  const clips = [{ len: 2, bumper: true }, { len: 7.23 }, { len: 1.6, bumper: true }, { len: 4 }, { len: 3, bumper: true }];
  assert.ok(near(onBeats(clips, beat), 18.6), "the whole bulletin's length");
  [0, 2, 9.6, 11.2, 15.6].forEach((at, i) => assert.ok(near(clips[i].at, at), `clip ${i} at ${clips[i].at}, not ${at}`));
  assert.ok(near(clips[1].pad, 11 / 30) && near(clips[3].pad, 0.4), "the stories are held (in whole frames), not trimmed");
  assert.ok(clips.filter((c) => c.bumper).every((c) => !c.pad), "the sting, wipes and end card keep their length");
  assert.ok(near(onBeats(clips, null), 535 / 30), "no beat found: the plain length, in whole frames");
  assert.ok(clips.every((c) => !c.pad));
});

test("beats in real music: a kick drum under steady chords, like the bulletin's own bed", async () => {
  const { execFileSync } = await import("node:child_process");
  const file = `/tmp/dv-beat-${process.pid}.wav`;
  try {
    for (const [period, phase] of [[0.5, 0], [0.6, 0.2], [0.42, 0.31]]) {
      execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", `aevalsrc='0.07*sin(2*PI*130.81*t)+0.05*sin(2*PI*196*t)+0.035*sin(2*PI*329.63*t)+0.06*sin(2*PI*60*t)*exp(-8*mod(t-${phase}+100*${period},${period}))':d=20:s=48000`, file]);
      const b = await beatOf(file);
      assert.ok(Math.abs(b.period - period) <= 0.011, `period ${b.period} for ${period}`);
      assert.ok(Math.abs(b.phase - phase) <= 0.021, `phase ${b.phase} for ${phase}`);
    }
  } finally { fs.rmSync(file, { force: true }); }
});

test("cutaways the editor placed: moved ones keep their time, dropped ones leave, none overlap or run past the end", () => {
  const job = { seconds: 30, photos: [{ file: "a.jpg" }, { file: "b.jpg" }, { file: "c.mp4", kind: "clip", seconds: 2 }] };
  const auto = cutawaySchedule(job, job.photos);
  assert.equal(auto.length, 3);
  const moved = cutawaySchedule({ ...job, cutawayAt: { "b.jpg": 4 }, cutawayOff: ["c.mp4"] }, job.photos);
  assert.deepEqual(moved.map((m) => m.file), ["b.jpg", "a.jpg"], "in time order; the dropped clip is gone");
  assert.equal(moved[0].t, 4);
  assert.equal(moved[0].moved, true);
  assert.ok(moved.every((m, i) => i === 0 || m.t >= moved[i - 1].t + moved[i - 1].show), "no overlap");
  const late = cutawaySchedule({ ...job, cutawayAt: { "a.jpg": 29.5 } }, job.photos).find((m) => m.file === "a.jpg");
  assert.ok(late && late.t + late.show <= 29.5, `kept inside the story (${late?.t})`);
  const clash = cutawaySchedule({ ...job, cutawayAt: { "a.jpg": 10, "b.jpg": 10 } }, job.photos);
  assert.ok(clash.every((m, i) => i === 0 || m.t >= clash[i - 1].t + clash[i - 1].show), "two set to the same time: the second waits");
  assert.equal(cutawaySchedule({ ...job, cutawayOff: ["a.jpg", "b.jpg", "c.mp4"] }, job.photos).length, 0);
});
