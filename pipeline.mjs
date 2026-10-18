// Pipeline steps: script → voice → compose → draft → avatar → final. Each step reads/writes one job object.
import { z } from "zod";
import { execFile } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const sh = promisify(execFile);
// Windows ships npx as npx.cmd, which Node only runs through a shell; our arguments are fixed strings, never user text.
const WIN = process.platform === "win32";
const npx = (args, opts = {}) => sh(WIN ? "npx.cmd" : "npx", args, { ...opts, shell: WIN });
export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data"); // DATA_DIR: test servers use a copy
// The AI picks one per story; the person can override it at script review.
export const TEMPLATES = { lead: "vt01-lead-desk", breaking: "vt03-breaking", numbers: "vt04-numbers-desk", points: "vt06-key-points", quote: "vt07-quote", photo: "vt08-photo-story" };
// Looks made with the template designer live in data/custom-templates/c-xxxxxxxx and build on one of the templates above.
export const CUSTOM_TEMPLATES = path.join(DATA, "custom-templates");
const customMeta = (key) => {
  const file = /^c-[a-f0-9]{8}$/.test(key ?? "") ? path.join(CUSTOM_TEMPLATES, key, "custom.json") : null;
  return file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
};
// The built-in kind a template is (a custom look is the kind of the template it was made from).
export const baseOf = (key) => customMeta(key)?.base ?? (TEMPLATES[key] ? key : "lead");
export const isApprovedCustom = (key) => customMeta(key)?.status === "approved";
const templateDir = (key) => (customMeta(key) ? path.join(CUSTOM_TEMPLATES, key) : path.join(ROOT, "templates", TEMPLATES[key] ?? TEMPLATES.lead));
export const templateDirOf = templateDir;
// Output shapes. Vertical stories use the one 9:16 layout whatever template the script picked.
export const FORMATS = { landscape: "Landscape 16:9", vertical: "Shorts & Reels 9:16" };
export const templateFor = (job) => job.format === "vertical" ? path.join(ROOT, "templates", "vt05-shorts") : templateDir(job.script.template);
// Prices in rupees, estimates of the paid plans; set your own plan's rates in .env.local.
const rate = (name, fallback) => Number(process.env[name] ?? fallback);
export const RATES = {
  geminiInPer1M: rate("GEMINI_INR_PER_1M_INPUT_TOKENS", 25), // about $0.30 per million input tokens
  geminiOutPer1M: rate("GEMINI_INR_PER_1M_OUTPUT_TOKENS", 210), // about $2.50 per million output tokens
  voicePer1K: rate("ELEVENLABS_INR_PER_1K_CHARS", 15), // Starter plan, about $5 for 30,000 characters
  presenterPerMin: rate("HEYGEN_INR_PER_MINUTE", 100),
};
// Adds what a paid call used to the story's running cost: { script|voice|presenter: { units, inr } }.
export function addCost(job, part, units, inr) {
  const c = (job.cost ??= {})[part] ??= { units: 0, inr: 0 };
  c.units += units;
  c.inr = Math.round((c.inr + inr) * 100) / 100;
}

// Mock mode makes no API calls: placeholder script, silent voice, placeholder avatar. `--mock` works on every OS.
export const MOCK = process.env.MOCK === "1" || process.argv.includes("--mock");

// code: ElevenLabs language_code; iso3: the MP4 subtitle track's language; font: the template font for the script.
export const LANGS = {
  en: { name: "English", badge: "English", code: "en", iso3: "eng" },
  te: { name: "Telugu", badge: "తెలుగు", code: "te", iso3: "tel", font: "Noto Sans Telugu" },
  hi: { name: "Hindi", badge: "हिन्दी", code: "hi", iso3: "hin", font: "Noto Sans Devanagari" },
  ta: { name: "Tamil", badge: "தமிழ்", code: "ta", iso3: "tam", font: "Noto Sans Tamil" },
  kn: { name: "Kannada", badge: "ಕನ್ನಡ", code: "kn", iso3: "kan", font: "Noto Sans Kannada" },
  ml: { name: "Malayalam", badge: "മലയാളം", code: "ml", iso3: "mal", font: "Noto Sans Malayalam" },
  mr: { name: "Marathi", badge: "मराठी", code: "mr", iso3: "mar", font: "Noto Sans Devanagari" },
  bn: { name: "Bengali", badge: "বাংলা", code: "bn", iso3: "ben", font: "Noto Sans Bengali" },
  gu: { name: "Gujarati", badge: "ગુજરાતી", code: "gu", iso3: "guj", font: "Noto Sans Gujarati" },
  or: { name: "Odia", badge: "ଓଡ଼ିଆ", code: "or", iso3: "ori", font: "Noto Sans Oriya" },
};

// Voice per language. Defaults are ElevenLabs built-in voices the free plan allows (Daniel, Brian); on a paid plan
// the Indian voices fit better, e.g. Arjun: ELEVENLABS_VOICE_EN=hEVeuEwuN5rfDgwQ85v8, ELEVENLABS_VOICE_TE=614hXxJLzZgeC6BDovkb.
// Pick voices that match the HeyGen avatar's gender.
// ELEVENLABS_VOICE_<CODE> picks a voice per language (e.g. ELEVENLABS_VOICE_TA); the default for the Indian languages
// is Brian, whose multilingual voice eleven_v3 uses for all of them.
export const voiceFor = (lang) => process.env[`ELEVENLABS_VOICE_${lang.toUpperCase()}`] || (lang === "en" ? "onwK4e9ZLuTAKqWW03F9" : "nPczCjzI2devNBz1zQrb");

const ScriptShape = z.object({
  template: z.enum(["lead", "breaking", "numbers", "points", "quote", "photo"]),
  template_reason: z.string(),
  category: z.string(),
  headline: z.string(),
  standfirst: z.string(),
  dateline_city: z.string(),
  narration: z.string(),
  ticker: z.array(z.string()),
  figure_value: z.string(),
  figure_label: z.string(),
  figure_context: z.string(),
  source_name: z.string(),
  quote_text: z.string(),
  quote_by: z.string(),
});
// Limits match the template boxes and keep the voice short; checked when a person approves the script.
export const Script = z.object({
  template: z.union([z.enum(["lead", "breaking", "numbers", "points", "quote", "photo"]), z.string().regex(/^c-[a-f0-9]{8}$/)]),
  // No length limits on what the video shows: text longer than a template's comfortable size is set smaller (fitStyles).
  template_reason: z.string().trim().default(""),
  category: z.string().trim().min(1),
  headline: z.string().trim().min(1),
  standfirst: z.string().trim(),
  dateline_city: z.string().trim(),
  narration: z.string().trim().min(1).max(2500), // the one cap left: voice cost and video length
  ticker: z.array(z.string().trim()),
  figure_value: z.string().trim().default(""),
  figure_label: z.string().trim().default(""),
  figure_context: z.string().trim().default(""),
  source_name: z.string().trim().default(""),
  quote_text: z.string().trim().default(""),
  quote_by: z.string().trim().default(""),
}).refine((s) => baseOf(s.template) !== "numbers" || (s.figure_value && s.figure_label), { message: "Numbers Desk needs a key figure and what it measures", path: ["figure_value"] })
  .refine((s) => baseOf(s.template) !== "quote" || (s.quote_text && s.quote_by), { message: "Quote needs the exact words and who said them", path: ["quote_text"] })
  .refine((s) => baseOf(s.template) !== "points" || s.ticker.length >= 2, { message: "Key Points needs at least two ticker lines to use as its points", path: ["ticker"] });

const SYSTEM = `You write broadcast scripts for Dashavani, a multilingual Indian news channel. An AI presenter reads your narration on camera.

Rules:
- Use ONLY facts stated in the source text. Never add names, numbers, dates, quotes or context that are not in it. If something is unclear, leave it out.
- Write every field in the requested language, in natural news-anchor style for that language (not a word-for-word translation).
- headline: one line, at most 90 characters.
- category: one word for the desk (e.g. ECONOMY, POLITICS, SPORTS), uppercase if English; at most 24 characters.
- standfirst: one sentence on why it matters, at most 120 characters.
- dateline_city: the city the story is from if the source names one, in uppercase Latin letters for English or the requested language's script otherwise; empty string if not named.
- narration: what the presenter says, 60–120 words, short spoken sentences, no headings or bullet points, starts directly with the news.
- ticker: 2–4 short related lines taken from the source, each at most 60 characters; uppercase if English.

Choose the video template (field "template") from the story itself and the editor's brief, and say why in one sentence (template_reason, in English):
- "breaking": the story is urgent or still developing (an alert, accident, disaster, sudden announcement), or the brief asks for breaking.
- "numbers": the story turns on one key figure (a rate, price, score, result, count) that should fill the screen, or the brief asks to focus on a number.
- "points": the story is a list of separate changes, benefits or decisions (a scheme, new rules, a budget's main items). Its ticker lines become the numbered points, so write 2–4 of them, each one complete point.
- "quote": the story centres on words a named person said, and the source quotes them directly.
- "lead": every other story.
Never choose "photo"; the editor picks it when a strong photo exists.
The editor's brief wins when it names a template or a treatment.
- figure_value: only for "numbers" — the key figure exactly as written in the source, at most 14 characters (e.g. "6.5%", "₹1,200"). Otherwise "".
- figure_label: only for "numbers" — what the figure is, at most 40 characters (uppercase if English). Otherwise "".
- figure_context: only for "numbers" — one short line of context from the source, at most 90 characters. Otherwise "".
- quote_text: only for "quote" — the exact quoted words copied from the source (translated faithfully if the source is in another language), at most 160 characters, without quotation marks. Keep the whole quote; a longer one is set smaller in the video. Write it in the story's language: if the speaker spoke another language, translate the quote; never leave it in the original language or script. Otherwise "".
- quote_by: only for "quote" — who said it, as the source names them (e.g. "CHIEF MINISTER N. CHANDRABABU NAIDU"), at most 50 characters, uppercase if English. Otherwise "".
- source_name: who the information comes from if the source text says so (e.g. "RBI"), at most 40 characters; otherwise "".`;

// One Gemini call that must answer JSON in the given zod shape; its tokens go on the story's script cost.
// The free plan is often busy (503/429) or hangs, so each try has a time limit, failures are retried,
// and after two tries on the main model it alternates with a lighter fallback model.
// onText(soFar): when given, the reply is streamed and onText sees the text each time a piece arrives.
export async function gemini(job, system, prompt, shape, what, onText) {
  const main = process.env.GEMINI_MODEL || "gemini-flash-latest", fallback = process.env.GEMINI_FALLBACK_MODEL || "gemini-flash-lite-latest";
  const plan = [main, main, fallback, main, fallback, fallback];
  const wait = Number(process.env.GEMINI_RETRY_MS ?? 4000);
  const key = need("GEMINI_API_KEY"); // a missing key is not "busy": say so at once
  let res, last;
  for (const [attempt, model] of plan.entries()) {
    if (attempt) await new Promise((r) => setTimeout(r, attempt * wait));
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:${onText ? "streamGenerateContent?alt=sse" : "generateContent"}`, {
        method: "POST",
        signal: AbortSignal.timeout(90_000),
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: Array.isArray(prompt) ? prompt : [{ text: prompt }] }], // text, or text plus images
          generationConfig: { responseMimeType: "application/json", responseJsonSchema: z.toJSONSchema(shape) },
        }),
      });
      if (res.status !== 503 && res.status !== 429) break;
      last = `${model} busy (${res.status})`;
    } catch (e) {
      res = null;
      last = `${model} ${e.name === "TimeoutError" ? "did not answer within 90 s" : `unreachable (${e.cause?.code ?? e.message})`}`;
    }
  }
  if (!res || res.status === 503 || res.status === 429) throw new Error(`Gemini is busy or not answering (${last}). Press "Retry this step" in a minute`);
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = onText ? await readStream(res, onText) : await res.json();
  const cand = data.candidates?.[0];
  if (!cand?.content) throw new Error(`Gemini returned no ${what} (${data.promptFeedback?.blockReason ?? cand?.finishReason ?? "no reason given"})`);
  const u = data.usageMetadata ?? {};
  addCost(job, "script", u.totalTokenCount ?? 0, ((u.promptTokenCount ?? 0) * RATES.geminiInPer1M + ((u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)) * RATES.geminiOutPer1M) / 1e6);
  const parsed = shape.safeParse(JSON.parse(cand.content.parts.map((p) => p.text ?? "").join("")));
  if (!parsed.success) throw new Error(`The ${what} came back in the wrong shape: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

// An English rendering of a non-English script, so someone who doesn't read the language can check its meaning.
const BACK = `Translate this news script into plain English for an editor who will check its meaning against the source.
Translate literally and faithfully: keep every name, number and claim exactly; add nothing; do not improve the wording.`;
const BackShape = z.object({ headline: z.string(), standfirst: z.string(), narration: z.string(), ticker: z.array(z.string()), quote_text: z.string() });
// A streamed reply (server-sent events, one JSON piece per "data:" line) put back together as one reply.
async function readStream(res, onText) {
  let text = "", buf = "", last = {};
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines.filter((l) => l.startsWith("data:"))) {
      const piece = JSON.parse(line.slice(5));
      text += piece.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      last = { ...last, ...piece };
      onText(text);
    }
  }
  const cand = last.candidates?.[0];
  return { ...last, candidates: cand && [{ ...cand, content: text ? { parts: [{ text }] } : cand.content }] };
}

// The headline and narration so far, read from a script reply that is still arriving (unfinished JSON).
export function partialScript(json) {
  const field = (k) => {
    const m = new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(json);
    if (!m) return "";
    try { return JSON.parse(`"${m[1].replace(/(?<!\\)((?:\\\\)*)\\(u[0-9a-fA-F]{0,3})?$/, "$1")}"`); } catch { return ""; } // drop an escape cut in half
  };
  return { headline: field("headline"), narration: field("narration") };
}
// Scripts being written now, by job id: what the story page shows while it waits. In memory only, never saved.
export const writing = new Map();

export async function backTranslate(job, script = job.script) {
  if (job.lang === "en" || !script) return null;
  const s = { headline: script.headline ?? "", standfirst: script.standfirst ?? "", narration: script.narration ?? "", ticker: script.ticker ?? [], quote_text: script.quote_text ?? "" };
  job.english = MOCK ? { ...s, narration: `(English) ${s.narration}` } : await gemini(job, BACK, `From ${LANGS[job.lang].name}:\n${JSON.stringify(s, null, 2)}`, BackShape, "English check");
  return job.english;
}

// Quality check of a rendered video: Gemini looks at three frames for faults a viewer would notice.
const CRITIC = `You check frames from a news video before an editor approves it. Report only real, visible faults:
text cut off or overflowing its box, text overlapping other text, text over a face, broken or garbled letters (including Indian scripts such as Telugu, Tamil or Bengali),
a photo that is badly cropped or stretched, a blank or black frame.
Not faults, by design: a subtitle line (a dark box with white text, one word in gold) shows only part of a sentence at a time;
a scrolling ticker is cut at the screen edge; text inside a box with comfortable padding is not cut off.
Severity: "high" = must fix before publishing, "medium" = should fix, "low" = cosmetic. Say where (the time) and what, in one plain sentence.`;
const CriticShape = z.object({ summary: z.string(), issues: z.array(z.object({ at: z.number(), severity: z.enum(["high", "medium", "low"]), problem: z.string() })) });
export async function critic(job, name) {
  const file = path.join(projectDir(job), "renders", name);
  const dur = job.seconds ?? 10;
  const times = [1.5, dur / 2, Math.max(2, dur - 1.5)].map((t) => Math.round(t * 10) / 10);
  if (MOCK) return (job.critic = { summary: "Mock mode: frames not checked.", issues: [], times });
  const frames = await Promise.all(times.map(async (t) => {
    const { stdout } = await sh("ffmpeg", ["-loglevel", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale=960:-2", "-f", "image2pipe", "-vcodec", "mjpeg", "-"], { encoding: "buffer", maxBuffer: 16 << 20 });
    return stdout.toString("base64");
  }));
  // Tell the checker which subtitle line is meant to be on screen at each frame, so a sentence fragment isn't reported as cut off.
  const plan = subtitlePlan(job), shown = plan.burn === job.lang && job.words?.length ? captionLines(job.words) : [];
  const subAt = (t) => shown.findLast((line) => line[0].s <= t)?.map((w) => w.w).join(" ");
  const parts = [{ text: `Frames at ${times.join(" s, ")} s of a ${job.format === "vertical" ? "9:16" : "16:9"} ${LANGS[job.lang].name} news video, in order.\n` +
    times.map((t) => subAt(t) ? `At ${t} s the subtitle box is meant to show exactly "${subAt(t)}" (a part of a sentence, on purpose).` : "").filter(Boolean).join("\n") },
    ...frames.map((data) => ({ inline_data: { mime_type: "image/jpeg", data } }))];
  job.critic = { ...(await gemini(job, CRITIC, parts, CriticShape, "quality check")), times };
  return job.critic;
}

// Whether a person should look closely before approving, and why.
export function reviewReasons(job) {
  const out = (job.warnings ?? []).map((w) => w);
  for (const i of job.critic?.issues ?? []) if (i.severity !== "low") out.push(`${i.problem} (at ${i.at} s)`);
  if ((job.subFiles ?? []).some((l) => l !== job.lang)) out.push("Translated subtitles need a read");
  if (job.script) out.push(...scriptMismatches(job.script, job.lang)); // e.g. a quote left in the speaker's language
  return out;
}

// A change asked for in plain words: Gemini returns the whole editable state with only that change made.
const CHANGE = `You edit a Dashavani news video on an editor's request. You get the current settings and the source text.
Make only the change the editor asks for and keep everything else exactly as it is. Facts may come only from the source text:
never add names, numbers, dates or claims. Keep each field's limits (headline 90 characters, standfirst 120, narration 60-120 words, ticker 2-4 lines of 60).
Templates: lead, breaking, numbers (needs figure_value and figure_label), points (ticker lines are the points), quote (needs quote_text and quote_by), photo.
subLangs are subtitle languages (en, te, hi); burn is the one shown on the video, or "off". presenter false means voice only.
If the request cannot be done with these settings (for example music, colours, voice style or anything not listed), leave everything unchanged and explain in refused.
note: one short sentence saying what you changed, for the version history.`;
const ChangeShape = z.object({ script: ScriptShape, presenter: z.boolean(), subLangs: z.array(z.string()), burn: z.string(), note: z.string(), refused: z.string() });
export async function applyChange(job, request) {
  const plan = subtitlePlan(job);
  const now = { script: job.script, presenter: job.presenter !== false, subLangs: plan.langs, burn: plan.burn };
  const out = MOCK
    ? { ...now, script: /shorter/i.test(request) ? { ...job.script, headline: job.script.headline.split(" ").slice(0, 6).join(" ") } : job.script, note: `Mock mode: ${/shorter/i.test(request) ? "shortened the headline" : "no change made"}.`, refused: "" }
    : await gemini(job, CHANGE, `Editor's request: ${request}\n\nLanguage: ${LANGS[job.lang].name}\n\nCurrent settings:\n${JSON.stringify(now, null, 2)}\n\nSource text:\n${job.input}`, ChangeShape, "change");
  if (out.refused) throw new Error(`Not changed: ${out.refused}`);
  const parsed = Script.safeParse(out.script);
  if (!parsed.success) throw new Error(`The change broke a rule: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const langs = [...new Set(out.subLangs)].filter((l) => Object.hasOwn(LANGS, l));
  Object.assign(job, { script: fixMixedScript(parsed.data, job.lang), presenter: out.presenter, subLangs: langs, burn: langs.includes(out.burn) ? out.burn : "off", changeNote: out.note });
  job.warnings = unsupportedNumbers(job.script, job.input);
}

// "Fix the language": broken words are repaired by letter mapping, and fields wholly in another language (a quote kept
// in the speaker's Hindi) are translated, field by field, into the story's language. Everything else stays as written.
const FIELDS_PROMPT = `You translate fields of a news video script into the target language for an Indian newsroom. Translate each numbered text
faithfully and completely: keep every name, number and date; add nothing; leave nothing out. Answer with exactly as many lines, in order.`;
export async function fixLanguage(job) {
  const script = fixMixedScript(job.script, job.lang), fields = foreignFields(script, job.lang);
  if (fields.length) {
    const texts = fields.map(([k, i]) => (i === undefined ? script[k] : script[k][i]));
    const out = MOCK ? texts : (await gemini(job, FIELDS_PROMPT, `Target language: ${LANGS[job.lang].name}\n\n${texts.map((t, n) => `${n + 1}. ${t.replace(/\s+/g, " ")}`).join("\n")}`, Lines, "language fix")).lines.map((l) => l.replace(/^\s*\d+[.)]\s*/, "").trim());
    if (out.length !== texts.length) throw new Error(`The translation came back with ${out.length} parts for ${texts.length}; try again`);
    fields.forEach(([k, i], n) => { if (i === undefined) script[k] = out[n]; else script[k] = script[k].map((l, j) => (j === i ? out[n] : l)); });
  }
  job.script = fixMixedScript(script, job.lang);
  job.warnings = unsupportedNumbers(job.script, job.input);
  job.changeNote = `Language fixed${fields.length ? `: translated ${fields.map(([k, i]) => (i === undefined ? FIELD[k] : `ticker line ${i + 1}`).toLowerCase()).join(", ")}` : ": repaired words"}`;
}

export async function writeScript(job) {
  if (MOCK) {
    const [first = "", second = ""] = job.input.split(/(?<=[.!?।])\s+/);
    const figure = job.input.match(/[₹$]?\d[\d,.]*\s?(%|crore|lakh)?/)?.[0].trim() ?? "";
    const template = /breaking|urgent|alert/i.test(`${job.brief} ${job.input}`) ? "breaking" : figure && /number|figure|rate|%/i.test(`${job.brief} ${job.input}`) ? "numbers" : "lead";
    job.script = {
      template, template_reason: "Mock mode: picked by keywords in the brief and text.",
      category: "NEWS", headline: first.slice(0, 90), standfirst: second.slice(0, 120), dateline_city: "", narration: job.input.slice(0, 600), ticker: [],
      figure_value: template === "numbers" ? figure.slice(0, 14) : "", figure_label: template === "numbers" ? "KEY FIGURE" : "", figure_context: "", source_name: "", quote_text: "", quote_by: "",
    };
    // Shown arriving a few words at a time, as a real one does (MOCK_TYPE_MS=0 skips it).
    const words = job.script.narration.split(" "), step = Math.ceil(words.length / 12), ms = Number(process.env.MOCK_TYPE_MS ?? 150);
    for (let n = step; ms && n < words.length + step; n += step) {
      writing.set(job.id, { headline: job.script.headline, narration: words.slice(0, n).join(" ") });
      await new Promise((r) => setTimeout(r, ms));
    }
    writing.delete(job.id);
  } else {
    const ask = `Language: ${LANGS[job.lang].name}\nEditor's brief: ${job.brief || "(none)"}\n\nSource text:\n${job.input}`;
    const first = fixMixedScript(await gemini(job, SYSTEM, ask, ScriptShape, "script", (text) => writing.set(job.id, partialScript(text)))
      .finally(() => writing.delete(job.id)), job.lang);
    const check = (s) => [...scriptProblems(s), ...scriptMismatches(s, job.lang)];
    const fixed = await fixScript(first, (problems) => gemini(job, SYSTEM, `${ask}\n\nYour last script broke these rules. Fix only these and keep everything else as it was:\n- ${problems.join("\n- ")}\n\nYour last script:\n${JSON.stringify(first)}`, ScriptShape, "script").then((s) => fixMixedScript(s, job.lang)), check);
    job.script = fixed.script; // anything still wrong is listed at review (the server checks the saved script)
  }
  job.warnings = unsupportedNumbers(job.script, job.input);
}

// Comfortable lengths per template element; longer text is scaled down in proportion (CSS zoom also shrinks the
// element's own box, so the line count stays what fits at the comfortable length). Never below 0.45: legibility.
const FIT = [["headline", "#headline", 90], ["standfirst", "#standfirst", 120], ["category", "#category", 24], ["quote_text", "#quote", 160],
  ["quote_by", "#by", 50], ["figure_value", "#figure", 14], ["figure_label", "#label", 40], ["figure_context", "#context", 90]];
const zoom = (len, comfy) => Math.max(0.45, Math.floor((comfy / len) * 100) / 100);
export function fitStyles(script) {
  const rules = FIT.filter(([k, , comfy]) => (script[k]?.trim().length ?? 0) > comfy).map(([k, sel, comfy]) => `${sel} { zoom: ${zoom(script[k].trim().length, comfy)}; }`);
  const point = Math.max(0, ...(script.ticker ?? []).map((l) => l.trim().length)); // Key Points shows the ticker lines as points
  if (point > 60) rules.push(`.point p { zoom: ${zoom(point, 60)}; }`);
  return rules.join(" ");
}

// Fields only some templates show (a quote, a key figure) are cleared for the others, so text the chosen
// template never shows can't block approval. Custom looks follow the template they were made from.
export function dropUnused(script) {
  const base = baseOf(script.template);
  return { ...script,
    ...(base !== "quote" && { quote_text: "", quote_by: "" }),
    ...(base !== "numbers" && { figure_value: "", figure_label: "", figure_context: "" }) };
}

// A script's broken rules in plain words ("Quote: keep it to 160 characters (now 214)"), for the writer and the editor.
const FIELD = { template: "Template", template_reason: "Template reason", category: "Category", headline: "Headline", standfirst: "Standfirst", dateline_city: "Dateline city", narration: "Narration",
  ticker: "Ticker", figure_value: "Key figure", figure_label: "What the figure measures", figure_context: "Figure context", source_name: "Source", quote_text: "Quote", quote_by: "Who said it" };
export function scriptProblems(script) {
  const r = Script.safeParse(script);
  if (r.success) return [];
  return r.error.issues.map((i) => {
    if (i.code === "custom") return i.message;
    const field = `${FIELD[i.path[0]] ?? i.path[0]}${i.path.length > 1 ? ` line ${i.path[1] + 1}` : ""}`;
    if (i.code === "too_big" && i.origin === "string") return `${field}: keep it to ${i.maximum} characters (now ${String(i.path.reduce((o, k) => o?.[k], script) ?? "").trim().length})`;
    if (i.code === "too_big" && i.origin === "array") return `${field}: at most ${i.maximum} lines`;
    if (i.code === "too_small" && i.origin === "string") return `${field}: can't be empty`;
    return `${field}: ${i.message}`;
  });
}

// On-screen and spoken text must be in the story's own writing system: a quote kept in the speaker's Hindi inside a
// Telugu story is wrong. Latin (names, acronyms like PIB or GST) is fine anywhere; the danda (।) is shared.
const BLOCKS = { deva: [0x0900, 0x097f], beng: [0x0980, 0x09ff], gujr: [0x0a80, 0x0aff], orya: [0x0b00, 0x0b7f], taml: [0x0b80, 0x0bff], telu: [0x0c00, 0x0c7f], knda: [0x0c80, 0x0cff], mlym: [0x0d00, 0x0d7f] };
const OWN = { hi: "deva", mr: "deva", bn: "beng", gu: "gujr", or: "orya", ta: "taml", te: "telu", kn: "knda", ml: "mlym", en: null };
const CHECKED = [["headline", "Headline"], ["standfirst", "Standfirst"], ["category", "Category"], ["narration", "Narration"], ["quote_text", "Quote"], ["quote_by", "Who said it"], ["figure_label", "What the figure measures"], ["figure_context", "Figure context"]];
const SCRIPT_NAME = { deva: "Devanagari", beng: "Bengali", gujr: "Gujarati", orya: "Oriya", taml: "Tamil", telu: "Telugu", knda: "Kannada", mlym: "Malayalam" };
const ownLetters = (lang) => (OWN[lang] ? new RegExp(`\\p{Script=${SCRIPT_NAME[OWN[lang]]}}`, "u") : /[A-Za-z]/);
const foreignIn = (lang) => (text) => [...String(text ?? "")].some((c) => {
  const cp = c.codePointAt(0);
  if (cp === 0x0964 || cp === 0x0965) return false;
  return Object.entries(BLOCKS).some(([b, [lo, hi]]) => b !== OWN[lang] && cp >= lo && cp <= hi);
});
const TEXT_FIELDS = CHECKED.map(([k]) => k);

// A word that slipped into another Indian script part-way ("કૂष्माંડાની": Gujarati with Hindi letters) is mapped letter by
// letter: the Indian scripts share one Unicode layout, so ष (U+0937) sits where Gujarati ષ (U+0AB7) does. Words wholly
// in another language are left alone (they need translating: foreignFields).
export function fixMixedScript(script, lang) {
  const own = OWN[lang];
  if (!own) return script;
  const mine = ownLetters(lang);
  const word = (w) => !mine.test(w) ? w : [...w].map((c) => {
    const cp = c.codePointAt(0);
    if (cp === 0x0964 || cp === 0x0965) return c;
    const from = Object.entries(BLOCKS).find(([b, [lo, hi]]) => b !== own && cp >= lo && cp <= hi);
    if (!from) return c;
    const to = String.fromCodePoint(BLOCKS[own][0] + cp - from[1][0]);
    return mine.test(to) ? to : c; // a letter the story's script lacks stays for the checks to flag
  }).join("");
  const fix = (t) => (typeof t === "string" ? t.split(/(\s+)/).map(word).join("") : t);
  return { ...script, ...Object.fromEntries(TEXT_FIELDS.filter((k) => k in script).map((k) => [k, fix(script[k])])), ticker: (script.ticker ?? []).map(fix) };
}

// Fields wholly in another language (no letter of the story's own script): these need translating.
export function foreignFields(script, lang) {
  const foreign = foreignIn(lang), mine = ownLetters(lang);
  const whole = (t) => foreign(t) && !mine.test(String(t ?? ""));
  return [...TEXT_FIELDS.filter((k) => whole(script[k])).map((k) => [k]), ...(script.ticker ?? []).flatMap((l, i) => (whole(l) ? [["ticker", i]] : []))];
}

export function scriptMismatches(script, lang) {
  if (!Object.hasOwn(OWN, lang)) return [];
  const foreign = foreignIn(lang);
  const name = LANGS[lang].name;
  return [...CHECKED.filter(([k]) => foreign(script[k])).map(([, label]) => `${label} is not in ${name}`),
    ...(script.ticker ?? []).flatMap((l, i) => (foreign(l) ? [`Ticker line ${i + 1} is not in ${name}`] : []))];
}

// A script that breaks a rule goes back to its writer once with the problems. We never cut the text ourselves
// (a quote must stay the speaker's exact words); what is still wrong is returned for the editor to fix.
export async function fixScript(script, ask, check = scriptProblems) {
  let problems = check(script);
  if (problems.length) {
    const again = await ask(problems).catch(() => null);
    const left = again ? check(again) : problems;
    if (again && left.length <= problems.length) [script, problems] = [again, left];
  }
  return { script, problems };
}

// Facts check: every number in the script must appear in the input.
export function unsupportedNumbers(script, input) {
  // Indian-script digits become 0-9: every Indian digit block starts at U+xx66 or U+xxE6, so (code - 6) & 15 is the digit.
  const norm = (s) => s.replace(/,/g, "").replace(/[\u0966-\u096F\u09E6-\u09EF\u0A66-\u0A6F\u0AE6-\u0AEF\u0B66-\u0B6F\u0BE6-\u0BEF\u0C66-\u0C6F\u0CE6-\u0CEF\u0D66-\u0D6F]/g, (c) => String((c.charCodeAt(0) - 6) & 15));
  const nums = (s) => norm(s).match(/\d+(\.\d+)?/g) ?? [];
  const source = new Set(nums(input)); // whole numbers: "5" is not supported by "15"
  const text = [script.headline, script.standfirst, script.narration, ...script.ticker, script.figure_value ?? "", script.figure_context ?? "", script.quote_text ?? ""].join(" ");
  return [...new Set(nums(text))].filter((n) => !source.has(n)).map((n) => `Number "${n}" is not in the source text`);
}

// Words with their spoken start and end (seconds), rebuilt from ElevenLabs' per-character timings.
export function toWords({ characters, character_start_times_seconds: starts, character_end_times_seconds: ends }) {
  const words = [];
  let cur = null;
  characters.forEach((ch, i) => {
    if (/\s/.test(ch)) { cur = null; return; }
    if (!cur) words.push(cur = { w: "", s: starts[i], e: ends[i] });
    cur.w += ch;
    cur.e = ends[i];
  });
  return words;
}

// A sentence ends at . ! ? or । even with a closing quote or bracket after it ("won." ).
const SENTENCE_END = /[.!?।]["'”’)\]]*$/;

// Caption lines: up to 5 words or 32 characters; a sentence end always breaks, a comma only after 3 words.
export function captionLines(words) {
  const lines = [];
  let line = [];
  for (const word of words) {
    if (line.length && (line.length >= 5 || [...line, word].map((x) => x.w).join(" ").length > 32)) { lines.push(line); line = []; }
    line.push(word);
    if (SENTENCE_END.test(word.w) || (/[,;:]["'”’)]*$/.test(word.w) && line.length >= 3)) { lines.push(line); line = []; }
  }
  if (line.length) lines.push(line);
  return lines;
}

// Spoken sentences with their time span, from the voice's word timings.
export function sentences(words) {
  const out = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    if (SENTENCE_END.test(w.w)) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return out.map((ws) => ({ text: ws.map((w) => w.w).join(" "), s: ws[0].s, e: ws.at(-1).e }));
}

// Translated subtitles: each translated sentence spans its spoken sentence, its words spread by length so lines split fairly.
export function translatedLines(spans, texts) {
  return spans.flatMap((span, i) => {
    const ws = texts[i].split(/\s+/).filter(Boolean);
    const total = ws.reduce((n, w) => n + w.length + 1, 0);
    let at = 0;
    return captionLines(ws.map((w) => {
      const s = span.s + ((span.e - span.s) * at) / total;
      at += w.length + 1;
      return { w, s, e: span.s + ((span.e - span.s) * at) / total };
    }));
  });
}

const TRANSLATE = `You translate subtitles for Dashavani, an Indian news channel. Translate each numbered sentence into the target language in natural news style.
Keep every fact, name and number exactly; add nothing; leave nothing out. Return one translated line for each input sentence, in the same order.`;
const Lines = z.object({ lines: z.array(z.string()) });

// Wire headlines for an editor reading the studio in another language: official titles, translated faithfully.
const HEADLINES = `You translate official Government of India press release titles for a newsroom tool. Translate each numbered title into the target language.
Keep every name, number, date and acronym exactly; add nothing; keep it a headline (no full stop added). Answer with exactly as many lines, in order.`;
export async function translateHeadlines(titles, lang) {
  if (MOCK) return titles;
  const { lines } = await gemini({}, HEADLINES, `Target language: ${LANGS[lang].name}\n\n${titles.map((t, i) => `${i + 1}. ${t}`).join("\n")}`, Lines, "wire headlines");
  return lines.map((l) => l.replace(/^\s*\d+[.)]\s*/, "").trim());
}
// Which subtitle languages a story makes (as selectable tracks and files), and which one is burned into the picture.
export function subtitlePlan(job) {
  if (job.subLangs) return { langs: job.subLangs, burn: job.burn ?? "off" };
  const one = job.subs ?? job.lang; // stories from before there could be several
  return one === "off" ? { langs: [], burn: "off" } : { langs: [one], burn: one };
}

// Subtitle lines in one language: the voice's own words (the spoken word can be lit), or a cached translation.
export async function subtitleLines(job, lang) {
  if (!job.words?.length) return null;
  if (lang === job.lang) return { lines: captionLines(job.words), highlight: true };
  if (job.subTrans?.lang) job.subTrans = { [job.subTrans.lang]: { key: job.subTrans.key, lines: job.subTrans.lines } }; // older single-language shape
  const spans = sentences(job.words);
  const key = createHash("sha256").update(JSON.stringify([job.script.narration, lang])).digest("hex").slice(0, 24);
  if (job.subTrans?.[lang]?.key !== key) {
    const texts = MOCK ? spans.map((sp) => `(${LANGS[lang].name}) ${sp.text}`)
      : (await gemini(job, TRANSLATE, `Target language: ${LANGS[lang].name}\n\n${spans.map((sp, i) => `${i + 1}. ${sp.text}`).join("\n")}`, Lines, "subtitle translation")).lines;
    if (texts.length !== spans.length) throw new Error(`Subtitle translation gave ${texts.length} lines for ${spans.length} sentences; try again`);
    job.subTrans = { ...job.subTrans, [lang]: { key, lines: texts } };
  }
  return { lines: translatedLines(spans, job.subTrans[lang].lines), highlight: false };
}

// SRT and WebVTT from caption lines. A cue lasts until the next one starts, or a second past its last word in a long pause.
export function cueFiles(lines) {
  const cues = lines.map((line, i) => ({ s: line[0].s, e: Math.min(lines[i + 1]?.[0].s ?? Infinity, line.at(-1).e + 1), text: line.map((w) => w.w).join(" ") }));
  const t = (sec, sep) => {
    const ms = Math.round(sec * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, x = Math.floor(ms / 1000) % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}${sep}${String(ms % 1000).padStart(3, "0")}`;
  };
  return {
    srt: cues.map((c, i) => `${i + 1}\n${t(c.s, ",")} --> ${t(c.e, ",")}\n${c.text}\n`).join("\n"),
    vtt: `WEBVTT\n\n${cues.map((c) => `${t(c.s, ".")} --> ${t(c.e, ".")}\n${c.text}\n`).join("\n")}`,
  };
}

// Puts each subtitle file into the rendered MP4 as a selectable track (video and audio copied, not re-encoded).
export async function addSubtitleTracks(job, name, offset = 0) {
  const langs = job.subFiles ?? [];
  if (!langs.length) return;
  const dir = projectDir(job), file = path.join(dir, "renders", name), tmp = `${file}.subs.mp4`;
  // offset: the intro sting comes before the story, so subtitle times move later by its length
  const args = ["-loglevel", "error", "-y", "-i", file, ...langs.flatMap((l) => ["-itsoffset", String(offset), "-i", path.join(dir, "subtitles", `${l}.srt`)]), "-map", "0:v", "-map", "0:a?"];
  langs.forEach((l, i) => args.push("-map", String(i + 1), `-metadata:s:s:${i}`, `language=${LANGS[l].iso3}`, `-metadata:s:s:${i}`, `title=${LANGS[l].name}`));
  await sh("ffmpeg", [...args, "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text", tmp]);
  fs.renameSync(tmp, file);
}

const USAGE = path.join(DATA, "voice-usage.jsonl");
// "2026-10" for a moment, in India time: the desk's month, not the server's UTC month.
const istMonth = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" }).format(new Date(d));
// Characters this app sent to ElevenLabs in the current calendar month (cache hits cost nothing).
// jobIds: count only those stories (one account's), or all when null.
export function voiceCharsThisMonth(now = new Date(), jobIds = null) {
  if (!fs.existsSync(USAGE)) return 0;
  const month = istMonth(now);
  return fs.readFileSync(USAGE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((u) => istMonth(u.at) === month && (!jobIds || jobIds.has(u.job))).reduce((n, u) => n + u.chars, 0);
}

// What this month's stories cost, by part, from each story's running cost.
export function monthSpend(jobs, now = new Date()) {
  const month = istMonth(now), out = { stories: 0, script: 0, voice: 0, presenter: 0, total: 0 };
  for (const j of jobs.filter((j) => j.cost && j.createdAt && istMonth(j.createdAt) === month)) { // stories that used a paid service
    out.stories++;
    for (const part of ["script", "voice", "presenter"]) out[part] += j.cost?.[part]?.inr ?? 0;
  }
  for (const k of ["script", "voice", "presenter"]) out[k] = Math.round(out[k] * 100) / 100;
  out.total = Math.round((out.script + out.voice + out.presenter) * 100) / 100;
  return out;
}

// The owner's view: this month's spend per account. Stories from before accounts are the owner's.
export const spendByAccount = (jobs, ownerId, now = new Date()) =>
  Object.entries(Object.groupBy(jobs, (j) => j.createdBy ?? ownerId)).map(([id, js]) => ({ id, ...monthSpend(js, now) })).filter((a) => a.stories);

export async function voice(job) {
  const out = path.join(projectDir(job), "assets/voice.wav");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const text = job.script.narration;
  if (MOCK) {
    const secs = Math.max(5, text.split(/\s+/).length / 2.5);
    await sh("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono", "-t", String(secs), out]);
    // Even spacing stands in for real timings so captions can be checked without a paid call.
    const ws = text.split(/\s+/).filter(Boolean);
    job.words = ws.map((w, i) => ({ w, s: (i * secs) / ws.length, e: ((i + 1) * secs) / ws.length }));
    Object.assign(job, { voiceChars: 0, voiceCached: false });
  } else {
    const voiceId = voiceFor(job.lang), model = process.env.ELEVENLABS_MODEL || "eleven_v3";
    // Same text, voice, model and language never pays ElevenLabs twice.
    const key = createHash("sha256").update(JSON.stringify([text, voiceId, model, job.lang])).digest("hex").slice(0, 24);
    const cached = path.join(DATA, "voice-cache", key);
    if (!fs.existsSync(`${cached}.json`)) {
      // eleven_v3 is the ElevenLabs model that speaks the Indian languages; with-timestamps also returns when each character is spoken.
      const speak = (code) => fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": need("ELEVENLABS_API_KEY"), "Content-Type": "application/json" },
        body: JSON.stringify({ text, model_id: model, ...(code && { language_code: code }) }),
      });
      let res = await speak(LANGS[job.lang].code);
      // eleven_v3 has no language code for some languages (Odia, 2026-10): it is refused, so the model detects the language itself.
      if (res.status === 400 && /does not support language_code/.test(await res.clone().text())) res = await speak(null);
      if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 400)}`);
      const data = await res.json();
      fs.mkdirSync(path.dirname(cached), { recursive: true });
      fs.writeFileSync(`${cached}.mp3`, Buffer.from(data.audio_base64, "base64"));
      await sh("ffmpeg", ["-loglevel", "error", "-y", "-i", `${cached}.mp3`, `${cached}.wav`]);
      fs.rmSync(`${cached}.mp3`);
      fs.appendFileSync(USAGE, JSON.stringify({ at: new Date().toISOString(), chars: text.length, job: job.id }) + "\n");
      // Written last: its presence marks a complete cache entry.
      fs.writeFileSync(`${cached}.json`, JSON.stringify(toWords(data.alignment)));
      Object.assign(job, { voiceChars: text.length, voiceCached: false });
      addCost(job, "voice", text.length, (text.length / 1000) * RATES.voicePer1K);
    } else Object.assign(job, { voiceChars: 0, voiceCached: true });
    fs.copyFileSync(`${cached}.wav`, out);
    job.words = JSON.parse(fs.readFileSync(`${cached}.json`, "utf8"));
  }
  const { stdout } = await sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]);
  job.seconds = Math.ceil(Number(stdout)) + 1;
  Object.assign(job, { voice: "voice.wav", voiceAt: Date.now() }); // voiceAt busts the browser cache after a re-record
}

export async function compose(job) {
  const dir = projectDir(job);
  fs.cpSync(templateFor(job), dir, { recursive: true, filter: (src) => !/[/\\](\.hyperframes|\.thumbnails|snapshots|renders)$/.test(src) });
  const s = job.script;
  const now = new Date();
  const ist = (o) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", ...o }).format(now).toUpperCase();
  const values = {
    category: s.category,
    headline: s.headline,
    standfirst: s.standfirst,
    badge: LANGS[job.lang].badge,
    // Breaking shows the time on its own, so its dateline stops at the date.
    dateline: [s.dateline_city, ist({ day: "2-digit", month: "short", year: "numeric" }), baseOf(s.template) !== "breaking" && `${ist({ hour: "2-digit", minute: "2-digit", hour12: false })} IST`].filter(Boolean).join("  ■  "),
    ticker: (s.ticker.length ? s.ticker : [s.headline]).join("  ■  "),
    clock: ist({ hour: "2-digit", minute: "2-digit", hour12: false }),
    figure_value: s.figure_value,
    figure_label: s.figure_label,
    figure_context: s.figure_context,
    source: s.source_name || "Dashavani desk",
    points: s.ticker.join("  ■  "),
    quote: s.quote_text,
    quote_by: s.quote_by,
    photo_credit: mediaPlan(job).framed?.from === "Uploaded" ? "Dashavani" : mediaPlan(job).framed?.from ?? "Dashavani",
  };
  let html = fillVariables(fs.readFileSync(path.join(dir, "index.html"), "utf8"), values);
  const fit = fitStyles(s);
  if (fit) html = html.replace("</head>", `<style id="fit">${fit}</style>\n  </head>`);
  html = html.replace(/<html lang="[^"]*"/, `<html lang="${job.lang}"`);
  html = setAttr(html, /<div\b[^>]*\bid="root"[^>]*>/, "data-duration", String(job.seconds));
  html = setAttr(html, /<audio\b[^>]*\bid="voice"[^>]*>/, "src", "assets/voice.wav");
  // Photo Story: the first photo fills the frame, so the cutaways use the rest.
  const { framed, cuts } = mediaPlan(job);
  if (framed) html = setAttr(html, /<img\b[^>]*\bid="photo"[^>]*>/, "src", `assets/photos/${framed.file}`);
  if (job.presenter === false && job.format !== "vertical") {
    // Landscape without a presenter: the panel goes and the story text takes its width; photos still cut in full screen.
    html = html.replace(">AI PRESENTER<", ">AI VOICE<").replace("</head>", `<style>#panel { display: none !important; } ${NO_PANEL[baseOf(s.template)] ?? ""}</style>\n  </head>`);
  } else if (job.presenter === false) {
    // Shorts & Reels without a presenter: the panel gets the slideshow or title card, and the label says the voice is AI.
    const [markup, script] = slateMarkup((job.photos ?? []).filter((p) => p.kind !== "clip"), { category: s.category, vertical: job.format === "vertical" }).split("<!--script-->");
    html = html.replace(/<video\b[^>]*\bid="avatar"[^>]*><\/video>/, markup).replace(">AI PRESENTER<", ">AI VOICE<").replace("</body>", `${script}\n  </body>`);
  }
  // Every chosen language becomes a subtitle file (and later an MP4 track); the burned-in one also goes into the picture.
  const plan = subtitlePlan(job), subDir = path.join(dir, "subtitles");
  fs.rmSync(subDir, { recursive: true, force: true });
  job.subFiles = [];
  for (const lang of plan.langs) {
    const sub = await subtitleLines(job, lang);
    if (!sub) continue;
    const { srt, vtt } = cueFiles(sub.lines);
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, `${lang}.srt`), srt);
    fs.writeFileSync(path.join(subDir, `${lang}.vtt`), vtt);
    job.subFiles.push(lang);
    if (lang !== plan.burn) continue;
    const [markup, script] = captionMarkup(sub.lines, { vertical: job.format === "vertical", lang, highlight: sub.highlight }).split("<!--script-->");
    html = html.replace(/(\n\s*<\/div>\s*\n\s*<script>)/, (m) => markup + m).replace("</body>", `${script}\n  </body>`);
  }
  const cutPhotos = cutawaySchedule(job, cuts);
  if (cutPhotos.length) {
    // Markup goes inside #root (the composition); its script goes last so the template's timeline already exists.
    const [markup, script] = cutawayMarkup(cutPhotos, { category: s.category, headline: s.headline, vertical: job.format === "vertical" }).split("<!--script-->");
    html = html.replace(/(\n\s*<\/div>\s*\n\s*<script>)/, (m) => markup + m).replace("</body>", `${script}\n  </body>`);
  }
  fs.writeFileSync(path.join(dir, "index.html"), html);
}

// Per landscape template: where the text and the AI label go once the presenter panel is gone.
export const NO_PANEL = {
  lead: "#story { width: 1800px; } #disclosure { left: auto; right: 60px; }",
  breaking: "#story { width: 1800px; } #disclosure { left: auto; right: 60px; }",
  numbers: "#main { width: 1776px; } #disclosure { left: auto; right: 72px; }",
  points: "#main { width: 1776px; } #disclosure { left: auto; right: 72px; }",
  quote: "#qwrap { left: 240px; width: 1440px; } #disclosure { right: 240px; top: auto; bottom: 99px; width: auto; }",
  photo: "#story { width: 1400px; } #disclosure { bottom: 120px; }",
};

export async function avatar(job) {
  const dir = projectDir(job);
  const voiceFile = path.join(dir, "assets/voice.wav");
  const out = path.join(dir, "assets/avatar.mp4");
  const avatarId = MOCK ? "mock" : need("HEYGEN_AVATAR_ID");
  // Same voice + same avatar never pays HeyGen twice.
  const key = createHash("sha256").update(fs.readFileSync(voiceFile)).update(avatarId).digest("hex");
  const cached = path.join(DATA, "avatar-cache", `${key}.mp4`);
  if (!fs.existsSync(cached)) {
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    if (MOCK) fs.copyFileSync(path.join(templateDir("lead"), "assets/avatar-placeholder.mp4"), cached);
    else {
      await heygenAvatar(voiceFile, avatarId, cached);
      const secs = job.seconds - 1;
      addCost(job, "presenter", secs, (secs / 60) * RATES.presenterPerMin);
    }
  }
  fs.copyFileSync(cached, out);
  const file = path.join(dir, "index.html");
  fs.writeFileSync(file, setAttr(fs.readFileSync(file, "utf8"), /<video\b[^>]*\bid="avatar"[^>]*>/, "src", "assets/avatar.mp4"));
}

// HeyGen films the chosen avatar lip-synced to our ElevenLabs voice (POST /v3/videos, type "avatar").
// The background matches the templates' presenter panel, so no keying is needed.
async function heygenAvatar(voiceFile, avatarId, out) {
  const api = async (p, init = {}) => {
    const res = await fetch(`https://api.heygen.com${p}`, { ...init, headers: { "X-Api-Key": need("HEYGEN_API_KEY"), ...init.headers } });
    if (!res.ok) throw new Error(`HeyGen ${p} ${res.status}: ${await res.text()}`);
    return (await res.json()).data;
  };
  const form = new FormData();
  form.append("file", await fs.openAsBlob(voiceFile, { type: "audio/wav" }), "voice.wav");
  const asset = await api("/v3/assets", { method: "POST", body: form });
  const { video_id } = await api("/v3/videos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "avatar", avatar_id: avatarId, audio_asset_id: asset.asset_id, background: { type: "color", value: "#222E63" }, aspect_ratio: "4:5", resolution: "1080p" }),
  });
  for (let i = 0; i < 180; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    const v = await api(`/v3/videos/${video_id}`);
    if (v.status === "failed") throw new Error(`HeyGen failed: ${v.failure_message ?? v.failure_code}`);
    if (v.status === "completed") {
      const res = await fetch(v.video_url);
      if (!res.ok) throw new Error(`HeyGen download ${res.status}`);
      fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
      return;
    }
  }
  throw new Error("HeyGen did not finish within 30 minutes");
}

// Opening sting and end card around every story, with a music bed: rendered once per format and reused.
export const BUMPER = { open: 2.4, close: 3, wipe: 0.8 };
function bumperHtml(vertical, mode) {
  const [w, h] = vertical ? [1080, 1920] : [1920, 1080], big = vertical ? 150 : 170;
  const open = mode === "open";
  if (mode === "wipe") return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=${w}, height=${h}">
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
  @font-face { font-family: "Anek Latin"; src: url("assets/fonts/AnekLatin.ttf") format("truetype"); font-weight: 100 800; font-stretch: 75% 125%; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${w}px; height: ${h}px; overflow: hidden; background: #16204a; }
  #root { position: relative; width: 100%; height: 100%; overflow: hidden; background: #16204a; color: #f3ede2; font-family: "Anek Latin", sans-serif; }
  #edge { position: absolute; top: 0; bottom: 0; left: 0; width: ${w * 0.06}px; background: #c9301a; }
  #mark { position: absolute; inset: 0; display: flex; justify-content: center; align-items: center; gap: ${big * 0.1}px; font-size: ${big * 0.5}px; font-weight: 800; font-stretch: 125%; }
  #mark span { padding-left: ${big * 0.1}px; border-left: ${big * 0.05}px solid #f0a202; font-size: ${big * 0.24}px; font-weight: 500; font-stretch: 75%; letter-spacing: .22em; }
</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${BUMPER.wipe}" data-width="${w}" data-height="${h}">
  <div id="mark">DASHA<span>VANI</span></div><div id="edge"></div>
</div>
<script>
  window.__timelines = window.__timelines || {};
  document.fonts.ready.then(() => {
    const tl = gsap.timeline({ paused: true });
    tl.fromTo("#edge", { x: -${w * 0.06} }, { x: ${w}, duration: 0.7, ease: "power2.inOut" }, 0);
    tl.fromTo("#mark", { opacity: 0 }, { opacity: 1, duration: 0.2 }, 0.15);
    tl.to("#mark", { opacity: 0, duration: 0.2 }, 0.55);
    window.__timelines["main"] = tl;
  });
</script></body></html>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=${w}, height=${h}">
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
  @font-face { font-family: "Anek Latin"; src: url("assets/fonts/AnekLatin.ttf") format("truetype"); font-weight: 100 800; font-stretch: 75% 125%; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${w}px; height: ${h}px; overflow: hidden; background: #16204a; }
  #root { position: relative; width: 100%; height: 100%; overflow: hidden; background: radial-gradient(60% 50% at 50% 50%, #222e63, #16204a 70%); color: #f3ede2; font-family: "Anek Latin", sans-serif; }
  .ring { position: absolute; left: 50%; top: 50%; width: ${Math.max(w, h) * 1.4}px; height: ${Math.max(w, h) * 1.4}px; margin: -${Math.max(w, h) * 0.7}px 0 0 -${Math.max(w, h) * 0.7}px; border: 3px solid rgba(240, 162, 2, .5); border-radius: 50%; opacity: 0; }
  #mark { position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-60%); display: flex; justify-content: center; align-items: center; gap: ${big * 0.16}px; }
  #mark .dash { font-size: ${big}px; line-height: .85; font-weight: 800; font-stretch: 125%; }
  #mark .bar { width: ${big * 0.08}px; height: ${big * 0.8}px; background: #f0a202; }
  #mark .vani { font-size: ${big * 0.48}px; line-height: .85; font-weight: 500; font-stretch: 75%; letter-spacing: .22em; }
  #rule { position: absolute; left: 50%; top: calc(50% + ${big * 0.55}px); width: ${big * 3.2}px; margin-left: -${big * 1.6}px; height: 6px; background: #c9301a; transform-origin: left; }
  #line { position: absolute; left: 0; right: 0; top: calc(50% + ${big * 0.85}px); text-align: center; font-size: ${big * 0.26}px; font-weight: 600; font-stretch: 75%; letter-spacing: .14em; }
  #small { position: absolute; left: 0; right: 0; bottom: ${vertical ? 420 : 80}px; text-align: center; font-size: ${big * 0.15}px; letter-spacing: .1em; color: #c4bfb3; }
</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${BUMPER[mode]}" data-width="${w}" data-height="${h}">
  <div class="ring"></div><div class="ring"></div><div class="ring"></div>
  <div id="mark"><div class="dash">DASHA</div><div class="bar"></div><div class="vani">VANI</div></div>
  <div id="rule"></div>
  <div id="line">${open ? "VERIFIED NEWS" : "VERIFIED NEWS, EVERY DAY"}</div>
  ${open ? "" : '<div id="small">AI PRESENTER. VERIFIED BY THE DASHAVANI DESK.</div>'}
</div>
<script>
  window.__timelines = window.__timelines || {};
  document.fonts.ready.then(() => {
    const tl = gsap.timeline({ paused: true });
    document.querySelectorAll(".ring").forEach((r, i) => tl.fromTo(r, { scale: 0.05, opacity: 1 }, { scale: 1, opacity: 0, duration: 1.8, ease: "power2.out" }, i * 0.25));
    tl.fromTo("#mark", { opacity: 0, scale: 1.18 }, { opacity: 1, scale: 1, duration: 0.7, ease: "expo.out" }, 0.15);
    tl.fromTo("#rule", { scaleX: 0 }, { scaleX: 1, duration: 0.5, ease: "power3.out" }, 0.6);
    tl.fromTo("#line", { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.5 }, 0.8);
    ${open ? 'tl.to("#root", { opacity: 0, duration: 0.25 }, 2.15);' : 'tl.fromTo("#small", { opacity: 0 }, { opacity: 1, duration: 0.5 }, 1.1);'}
    window.__timelines["main"] = tl;
  });
</script></body></html>`;
}
async function bumper(vertical, mode) {
  const html = bumperHtml(vertical, mode);
  const key = createHash("sha256").update(html).digest("hex").slice(0, 12);
  const dir = path.join(DATA, "bumpers", `${mode}-${vertical ? "v" : "h"}-${key}`), out = path.join(dir, "renders", "bumper.mp4");
  if (fs.existsSync(out)) return out;
  fs.cpSync(templateDir("lead"), dir, { recursive: true, filter: (src) => !/[/\\](\.hyperframes|\.thumbnails|snapshots|renders)$/.test(src) });
  fs.writeFileSync(path.join(dir, "index.html"), html);
  await npx(["hyperframes", "render", "--quality", "standard", "-o", "renders/bumper.mp4"], { cwd: dir, maxBuffer: 64 << 20 });
  return out;
}
// A whoosh for the sting and a soft pad for the bed, made by ffmpeg once: no licence question.
async function bumperAudio() {
  const dir = path.join(DATA, "audio"), whoosh = path.join(dir, "whoosh.wav"), bed = path.join(dir, "bed.wav");
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(whoosh)) await sh("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "anoisesrc=d=1.4:c=pink:a=0.6:r=48000", "-f", "lavfi", "-i", "sine=f=62:d=1.4:sample_rate=48000",
    "-filter_complex", "[0]highpass=f=500,lowpass=f=7000,afade=t=in:d=0.5,afade=t=out:st=0.6:d=0.8,volume=0.55[n];[1]afade=t=out:st=0.05:d=1.3,volume=0.9[b];[n][b]amix=inputs=2:normalize=0,aformat=channel_layouts=stereo", whoosh]);
  if (!fs.existsSync(bed)) await sh("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i",
    "aevalsrc='0.07*sin(2*PI*130.81*t)+0.05*sin(2*PI*196*t)+0.035*sin(2*PI*329.63*t)+0.03*sin(2*PI*261.63*t)*(0.6+0.4*sin(2*PI*0.25*t))+0.05*sin(2*PI*65.41*t)*exp(-7*mod(t,0.5))':d=60:s=48000",
    "-af", "lowpass=f=1400,aformat=channel_layouts=stereo", bed]);
  return { whoosh, bed };
}
// The music's beat, found in the music itself (no librosa needed): loudness every 10 ms, the rise in loudness as
// "something hit", the gap between hits that repeats most (60 to 200 beats a minute), then the offset where hits land.
// beatOf listens to the bass only (below ~100 Hz, where kick drums are): steady chords above it would drown the pulse.
export function findBeat(samples, rate) {
  const hop = Math.round(rate / 100), energy = [];
  for (let i = 0; i + hop <= samples.length; i += hop) { let e = 0; for (let k = i; k < i + hop; k++) e += samples[k] * samples[k]; energy.push(e); }
  const hit = energy.map((e, i) => Math.max(0, e - (energy[i - 1] ?? e)));
  const score = (lag) => { let s = 0; for (let i = lag; i < hit.length; i++) s += hit[i] * hit[i - lag]; return s / (hit.length - lag); };
  const scores = Array.from({ length: 71 }, (_, k) => score(30 + k)), best = Math.max(...scores);
  if (!(best > 0)) return null; // silence: no beat
  const lag = 30 + scores.findIndex((x) => x >= best * 0.9); // the shortest gap that repeats almost as strongly (not its double)
  const onGrid = (p) => { let s = 0; for (let i = p; i < hit.length; i += lag) s += hit[i]; return s; };
  let phase = 0;
  for (let p = 1; p < lag; p++) if (onGrid(p) > onGrid(phase)) phase = p;
  return { period: lag / 100, phase: phase / 100 };
}
export async function beatOf(file) {
  const { stdout } = await sh("ffmpeg", ["-loglevel", "error", "-i", file, "-t", "30", "-ac", "1", "-af", "lowpass=f=100,lowpass=f=100,lowpass=f=100", "-ar", "8000", "-f", "f32le", "-"], { encoding: "buffer", maxBuffer: 64 << 20 });
  return findBeat(new Float32Array(stdout.buffer, stdout.byteOffset, stdout.length >> 2), 8000);
}
// Lays the clips end to end (sets each one's .at) and returns the total length, in whole video frames (the joined video
// is 30 fps, so a clip lasts a whole number of frames). With a beat, each story is held on its last frame (.pad) just
// long enough that the cut after it falls on a beat (to the nearest frame); nothing is ever trimmed.
export function onBeats(clips, beat, fps = 30) {
  const frames = (x) => Math.round(x * fps);
  let n = 0; // frames so far
  clips.forEach((c, i) => {
    c.at = n / fps;
    n += frames(c.len);
    const next = clips[i + 1];
    c.pad = beat && !c.bumper && next?.bumper ? frames(beat.phase + Math.ceil((n / fps - beat.phase - 1e-6) / beat.period) * beat.period) - n : 0;
    n += c.pad;
    c.pad /= fps;
  });
  return n / fps;
}

// Joins stories with the sting first, a wipe between stories, the end card last and one music bed under all of it.
// segments: [{ file, start, len }] — the part of each story video to use. The music is up over the bumpers, down under the stories.
export async function stitch(segments, vertical, out) {
  const open = await bumper(vertical, "open"), close = await bumper(vertical, "close"), wipe = segments.length > 1 ? await bumper(vertical, "wipe") : null;
  const { whoosh, bed } = await bumperAudio();
  const clips = [{ file: open, len: BUMPER.open, bumper: true }];
  segments.forEach((seg, i) => { if (i) clips.push({ file: wipe, len: BUMPER.wipe, bumper: true }); clips.push(seg); });
  clips.push({ file: close, len: BUMPER.close, bumper: true });
  // Bulletins (several stories) cut on the music's beat; a single story's video keeps its own timing.
  const T = onBeats(clips, segments.length > 1 ? await beatOf(bed).catch(() => null) : null), stories = clips.filter((c) => !c.bumper), hits = [0, ...clips.filter((c) => c.file === wipe).map((c) => c.at)]; // a whoosh at the sting and each wipe
  const inputs = clips.flatMap((c) => [...(c.start ? ["-ss", String(c.start)] : []), "-t", String(c.len), "-i", c.file]);
  const n = clips.length, ms = (x) => Math.round(x * 1000);
  const graph = [
    // Exactly the planned frames per clip (held on its last frame, then cut), so every cut is where the timeline says.
    clips.map((c, i) => `[${i}:v]fps=30,setsar=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${c.pad + 1},trim=end_frame=${Math.round((c.len + c.pad) * 30)}[v${i}]`).join(";"),
    `${clips.map((_, i) => `[v${i}]`).join("")}concat=n=${n}:v=1:a=0[v]`,
    ...stories.map((c, k) => `[${clips.indexOf(c)}:a]aresample=48000,asetpts=PTS-STARTPTS,adelay=${ms(c.at)}|${ms(c.at)},apad=whole_dur=${T}[s${k}]`),
    `[${n}:a]asplit=${hits.length}${hits.map((_, k) => `[wh${k}]`).join("")}`,
    ...hits.map((at, k) => `[wh${k}]adelay=${ms(at)}|${ms(at)},apad=whole_dur=${T}[w${k}]`),
    `[${n + 1}:a]atrim=0:${T},volume='if(${stories.map((c) => `between(t,${c.at},${c.at + c.len + c.pad})`).join("+")},0.22,1)':eval=frame,afade=t=in:d=0.3,afade=t=out:st=${T - 1.2}:d=1.2[bed]`,
    `${stories.map((_, k) => `[s${k}]`).join("")}${hits.map((_, k) => `[w${k}]`).join("")}[bed]amix=inputs=${stories.length + hits.length + 1}:normalize=0:duration=first[a]`,
  ];
  await sh("ffmpeg", ["-loglevel", "error", "-y", ...inputs, "-i", whoosh, "-stream_loop", "-1", "-i", bed, "-filter_complex", graph.join(";"),
    "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out], { maxBuffer: 64 << 20 });
  return T;
}
const duration = async (file) => Number((await sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file])).stdout);
// One story: its render with the sting, end card and music around it. The bare story render is kept for bulletins.
export async function assemble(job, storyName, outName) {
  const r = path.join(projectDir(job), "renders"), story = path.join(r, storyName);
  await stitch([{ file: story, len: await duration(story) }], job.format === "vertical", path.join(r, outName));
  return outName;
}
// The bare story part of a story's newest video, without its own intro and end card.
export async function storySegment(job) {
  const name = job.finals?.at(-1) ?? job.draft;
  if (!name) return null;
  const r = path.join(projectDir(job), "renders"), bare = path.join(r, name.replace(/\.mp4$/, ".story.mp4"));
  if (fs.existsSync(bare)) return { file: bare, len: await duration(bare) };
  // No bare render kept (older videos): if the video is longer than its story by the intro and end card, use only the middle.
  const file = path.join(r, name), len = await duration(file), extra = BUMPER.open + BUMPER.close;
  return job.seconds && Math.abs(len - job.seconds - extra) < 1 ? { file, start: BUMPER.open, len: len - extra } : { file, len };
}

export async function render(job, name, quality = "standard") {
  const dir = projectDir(job);
  fs.mkdirSync(path.join(dir, "renders"), { recursive: true });
  await npx(["hyperframes", "render", "--quality", quality, "-o", `renders/${name}.mp4`], { cwd: dir, maxBuffer: 64 << 20 });
  return `${name}.mp4`;
}

// One Studio at a time keeps the 8 GB machine usable.
export async function openStudio(job) {
  const dir = projectDir(job);
  await npx(["hyperframes", "preview", "--kill-all"], { cwd: dir }).catch(() => {});
  await npx(["hyperframes", "preview", "--background", "--no-open"], { cwd: dir });
  for (let i = 0; i < 30; i++) {
    if (await fetch("http://localhost:3002/").then((r) => r.ok, () => false)) return `http://localhost:3002/#project/${job.id}`;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Studio did not start on port 3002");
}

export const projectDir = (job) => path.join(DATA, "projects", job.id);

// Story photos and clips live in the project's assets/photos and show as full-screen cutaways while the presenter speaks.
export const PHOTO_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
export const CLIP_TYPES = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };
// What each picture type's file starts with: the bytes decide, not the type the browser claims.
const MAGIC = { "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, "image/png": (b) => b.subarray(0, 8).equals(Buffer.from("\x89PNG\r\n\x1a\n", "latin1")),
  "image/webp": (b) => b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP" };
export const MAX_PHOTOS = 6, MAX_PHOTO_BYTES = 8 << 20, MAX_CLIP_BYTES = 100 << 20;
export async function savePhoto(job, bytes, type, from) {
  const clip = Object.hasOwn(CLIP_TYPES, type);
  if (!PHOTO_TYPES[type] && !clip) throw new Error("Photos must be JPEG, PNG or WebP; clips MP4, MOV or WebM");
  if (bytes.length > (clip ? MAX_CLIP_BYTES : MAX_PHOTO_BYTES)) throw new Error(clip ? "Clip is larger than 100 MB" : "Photo is larger than 8 MB");
  if ((job.photos?.length ?? 0) >= MAX_PHOTOS) throw new Error(`A story can have at most ${MAX_PHOTOS} photos and clips`);
  if (!clip && !MAGIC[type](bytes)) throw new Error(`That file is not a ${PHOTO_TYPES[type] === "jpg" ? "JPEG" : PHOTO_TYPES[type].toUpperCase()} picture`);
  const dir = path.join(projectDir(job), "assets/photos");
  fs.mkdirSync(dir, { recursive: true });
  const id = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  if (job.photos?.some((p) => p.file.startsWith(id))) return; // the same picture or clip twice
  if (!clip) {
    fs.writeFileSync(path.join(dir, `${id}.${PHOTO_TYPES[type]}`), bytes);
    job.photos = [...(job.photos ?? []), { file: `${id}.${PHOTO_TYPES[type]}`, from }];
    return;
  }
  // Clips become silent H.264 at most 1080 high (what the renderer plays), with a still for the blurred fill and the review grid.
  const src = path.join(dir, `${id}.src.${CLIP_TYPES[type]}`);
  fs.writeFileSync(src, bytes);
  try {
    await sh("ffmpeg", ["-loglevel", "error", "-y", "-i", src, "-an", "-vf", "scale=-2:'min(1080,ih)',format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-movflags", "+faststart", path.join(dir, `${id}.mp4`)]);
    await sh("ffmpeg", ["-loglevel", "error", "-y", "-ss", "0.5", "-i", path.join(dir, `${id}.mp4`), "-frames:v", "1", "-q:v", "3", path.join(dir, `${id}.jpg`)]);
    const { stdout } = await sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.join(dir, `${id}.mp4`)]);
    // Shot changes (scene score over 0.3), so a cutaway can start on a clean cut instead of mid-shot.
    const { stderr } = await sh("ffmpeg", ["-hide_banner", "-i", path.join(dir, `${id}.mp4`), "-vf", "select='gt(scene,0.3)',showinfo", "-an", "-f", "null", "-"], { maxBuffer: 16 << 20 });
    job.photos = [...(job.photos ?? []), { file: `${id}.mp4`, poster: `${id}.jpg`, kind: "clip", seconds: Math.round(Number(stdout) * 10) / 10, cuts: sceneCuts(stderr), from }];
  } catch {
    for (const f of [`${id}.mp4`, `${id}.jpg`]) fs.rmSync(path.join(dir, f), { force: true }); // ffmpeg may have started writing them
    throw new Error("That clip could not be read; try an MP4");
  }
  finally { fs.rmSync(src, { force: true }); }
}

// Times of the shot changes in ffmpeg's showinfo report (one line per frame the scene filter picked).
export const sceneCuts = (report) => [...report.matchAll(/pts_time:([\d.]+)/g)].map((m) => Math.round(Number(m[1]) * 100) / 100);
// Where a clip starts playing in its cutaway: the first shot change (past the opening frame) that leaves `show`
// seconds of clip after it, else the beginning.
export const clipStart = (clip, show) => clip.cuts?.find((c) => c > 0.2 && c + show <= clip.seconds) ?? 0;

// When each cutaway shows: spaced through the story, each moved to the nearest sentence start (a pause in the voice)
// if one is close and it doesn't run into the previous cutaway. A clip shows no longer than it runs.
// The editor may move a cutaway (job.cutawayAt: { file: seconds }) or leave it out (job.cutawayOff: [file]);
// placed ones keep their time, then all are put in order, nudged so none overlap and none run past the story's end.
export function cutawaySchedule(job, items) {
  const off = new Set(job.cutawayOff ?? []), at = job.cutawayAt ?? {};
  const auto = autoSchedule(job, items.filter((p) => !off.has(p.file)));
  if (!Object.keys(at).length) return auto;
  const total = job.seconds ?? 10, r = (x) => Math.round(x * 100) / 100, out = [];
  const placed = auto.map((p) => (Object.hasOwn(at, p.file) ? { ...p, t: r(Math.min(Math.max(0, at[p.file]), total - 0.5 - p.show)), snapped: false, moved: true } : p));
  for (const p of placed.sort((x, y) => x.t - y.t)) {
    const t = Math.max(p.t, out.length ? r(out.at(-1).t + out.at(-1).show + 0.3) : 0);
    if (t + p.show <= total - 0.5) out.push({ ...p, t });
  }
  return out;
}
function autoSchedule(job, items) {
  const total = job.seconds ?? 10, start = Math.min(3, total * 0.25), end = total - 1.5;
  const n = Math.min(items.length, Math.max(0, Math.floor((end - start) / 2.5)));
  const slot = (end - start) / Math.max(1, n), show = Math.min(4, slot * 0.7);
  const pauses = job.words?.length ? sentences(job.words).map((x) => x.s) : [];
  const out = [];
  for (const [i, item] of items.slice(0, n).entries()) {
    const even = start + i * slot + (slot - show) / 2;
    const near = pauses.reduce((best, x) => (Math.abs(x - even) < Math.abs(best - even) ? x : best), Infinity);
    const free = (out.at(-1)?.t ?? -Infinity) + (out.at(-1)?.show ?? 0) + 0.3;
    const snapped = Math.abs(near - even) <= 1.5 && near >= free && near + show <= total - 0.5;
    const r = (x) => Math.round(x * 100) / 100;
    const t = snapped ? near : Math.max(even, free), len = item.kind === "clip" ? Math.min(show, item.seconds) : show;
    if (t + len > total - 0.5) break; // pushed past the end by earlier snaps: fewer cutaways rather than overlapping ones
    out.push({ ...item, t: r(t), show: r(len), snapped });
  }
  return out;
}

// What the timeline view shows: the voice sentence by sentence, and when each photo or clip appears and why.
export function timelineFor(job) {
  if (!job.seconds || !job.script) return null;
  const { framed, cuts } = mediaPlan(job);
  return {
    total: job.seconds,
    sentences: job.words?.length ? sentences(job.words) : [],
    framed: framed ? { file: framed.file, from: framed.from } : null,
    media: cutawaySchedule(job, cuts).map(({ file, poster, kind, from, t, show, snapped }) => ({ file, poster, kind: kind ?? "photo", from, t, show, snapped })),
  };
}
// Photo Story frames its first photo (never a clip); everything else becomes a cutaway.
function mediaPlan(job) {
  const all = job.photos ?? [];
  const framed = job.format !== "vertical" && baseOf(job.script?.template) === "photo" ? all.find((p) => p.kind !== "clip") : null;
  return { framed, cuts: all.filter((p) => p !== framed) };
}

// Voice-only Shorts & Reels: the presenter panel shows the story photos as a slow slideshow, or a Dashavani title card without photos.
export function slateMarkup(photos, { category, vertical }) {
  const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const body = photos.length
    ? photos.map((p) => `<img class="slide" src="assets/photos/${p.file}" alt="">`).join("")
    : `<div class="card">${[0, 1, 2].map(() => '<i class="ring"></i>').join("")}<div class="mark">DASHA<span>VANI</span></div><div class="cat">${esc(category)}</div></div>`;
  return `<div id="slate"${vertical ? ' class="v"' : ""}>${body}</div>
        <style>
          #slate { position: absolute; inset: 0; overflow: hidden; background: #222e63; }
          #slate .slide { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; }
          #slate .card { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px; color: #f3ede2; }
          #slate.v .card { justify-content: flex-start; padding-top: 150px; } /* clear of the subtitles lower down */
          #slate.v .ring { top: 330px; }
          #slate .ring { position: absolute; left: 50%; top: 50%; width: 900px; height: 900px; margin: -450px 0 0 -450px; border: 2px solid rgba(240, 162, 2, .55); border-radius: 50%; opacity: 0; }
          #slate .mark { position: relative; display: flex; align-items: center; gap: 18px; font-size: 120px; line-height: .85; font-weight: 800; font-stretch: 125%; }
          #slate .mark span { padding-left: 18px; border-left: 10px solid #f0a202; font-size: 52px; font-weight: 500; font-stretch: 75%; letter-spacing: .22em; }
          #slate .cat { position: relative; background: #f0a202; color: #16204a; padding: 8px 20px; font-size: 28px; font-weight: 700; font-stretch: 75%; letter-spacing: .2em; }
        </style><!--script-->
    <script>
        document.fonts.ready.then(() => {
          const tl = window.__timelines.main;
          const total = Number(document.getElementById("root").dataset.duration);
          const slides = [...document.querySelectorAll("#slate .slide")];
          // Photos share the whole story, each crossfading into the next with a slow push-in.
          const each = total / Math.max(1, slides.length);
          slides.forEach((img, i) => {
            const t = i * each;
            tl.fromTo(img, { opacity: i ? 0 : 1 }, { opacity: 1, duration: i ? 0.8 : 0.01, immediateRender: i === 0 }, t);
            tl.fromTo(img, { scale: 1 }, { scale: 1.1, duration: each + 0.8, ease: "none", immediateRender: false }, t);
          });
          // Title card: signal rings spread out from the mark, one after another, for the whole story.
          document.querySelectorAll("#slate .ring").forEach((r, i) => {
            tl.fromTo(r, { scale: 0.15, opacity: 0.9 }, { scale: 1.3, opacity: 0, duration: 3.6, ease: "none", repeat: Math.ceil(total / 3.6), immediateRender: false }, i * 1.2);
          });
        });
    </script>`;
}

// Subtitles: one line at a time, timed to the voice, with the word being spoken in gold. Above everything else.
export function captionMarkup(lines, { vertical, lang, highlight }) {
  const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return `
      <div id="captions" class="${vertical ? "v" : "h"}" lang="${lang}">
        ${lines.map((line) => `<div class="cap" data-s="${line[0].s}" data-e="${line.at(-1).e}">${line.map((w) => `<span data-s="${w.s}" data-e="${w.e}">${esc(w.w)}</span>`).join(" ")}</div>`).join("\n        ")}
      </div>
      <style>
        #captions { position: absolute; left: 0; right: 0; z-index: 7; display: grid; justify-items: center; pointer-events: none; }
        #captions.h { bottom: 150px; } #captions.v { top: 1450px; left: 64px; right: 140px; } /* below the presenter's face, above the apps' own buttons */
        #captions .cap { grid-area: 1 / 1; opacity: 0; max-width: 1500px; padding: 10px 24px 12px; background: rgba(10, 14, 36, .82); color: #ffffff; text-align: center;
          font-size: 50px; line-height: 1.2; font-weight: 700; font-stretch: 87%; }
        #captions.v .cap { font-size: 56px; }
        #captions:not(:lang(en)) .cap { line-height: 1.45; padding: 12px 28px 16px; } /* Indic scripts stack signs above and below */
      </style><!--script-->
    <script>
        document.fonts.ready.then(() => {
          const tl = window.__timelines.main;
          const caps = [...document.querySelectorAll("#captions .cap")];
          caps.forEach((cap, i) => {
            // Each line stays up until the next one starts, so short pauses don't blink.
            const s = Number(cap.dataset.s), e = caps[i + 1] ? Number(caps[i + 1].dataset.s) : Number(cap.dataset.e) + 0.6;
            tl.set(cap, { opacity: 1 }, s);
            tl.set(cap, { opacity: 0 }, e);
            if (${highlight ? "true" : "false"}) cap.querySelectorAll("span").forEach((w) => {
              tl.set(w, { color: "#f0a202" }, Number(w.dataset.s));
              tl.set(w, { color: "#ffffff" }, Number(w.dataset.e));
            });
          });
        });
    </script>`;
}

// Cutaways at their scheduled times: photos with a slow push-in, clips playing silently; the headline as a lower third.
export function cutawayMarkup(items, { category, headline, vertical }) {
  const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return `
      <div id="cutaways" class="${vertical ? "v" : "h"}">
        ${items.map((p) => p.kind === "clip"
          ? `<div class="cut" data-t="${p.t}" data-show="${p.show}"><img class="bg" src="assets/photos/${p.poster}" alt=""><video class="fg" src="assets/photos/${p.file}" data-start="${p.t}" data-duration="${p.show}" data-playback-start="${clipStart(p, p.show)}" muted playsinline></video></div>`
          : `<div class="cut" data-t="${p.t}" data-show="${p.show}"><img class="bg" src="assets/photos/${p.file}" alt=""><img class="fg zoom" src="assets/photos/${p.file}" alt=""></div>`).join("")}
        <div class="cut-label"><span class="cat">${esc(category)}</span><span class="hl">${esc(headline)}</span></div>
      </div>
      <style>
        #cutaways { position: absolute; inset: 0; z-index: 5; pointer-events: none; }
        #ticker { z-index: 6; }
        #cutaways .cut { position: absolute; inset: 0; overflow: hidden; opacity: 0; background: #16204a; }
        #cutaways img, #cutaways video { position: absolute; inset: 0; width: 100%; height: 100%; }
        #cutaways .bg { object-fit: cover; filter: blur(40px) brightness(.55); transform: scale(1.2); }
        #cutaways .fg { object-fit: contain; }
        #cutaways .cut-label { position: absolute; left: 60px; right: 60px; display: flex; flex-direction: column; align-items: flex-start; gap: 12px; opacity: 0; }
        #cutaways.h .cut-label { top: 60px; } #cutaways.v .cut-label { top: 830px; left: 64px; right: 140px; }
        #cutaways .cat { background: #f0a202; color: #16204a; padding: 8px 18px; font-size: 24px; font-weight: 700; font-stretch: 75%; letter-spacing: .2em; }
        #cutaways .hl { background: rgba(22, 32, 74, .92); color: #f3ede2; padding: 14px 22px; font-size: 44px; line-height: 1.1; font-weight: 700; font-stretch: 87%; max-width: 1300px; }
      </style><!--script-->
    <script>
        document.fonts.ready.then(() => {
          const tl = window.__timelines.main;
          const label = document.querySelector("#cutaways .cut-label");
          document.querySelectorAll("#cutaways .cut").forEach((c) => {
            const t = Number(c.dataset.t), show = Number(c.dataset.show);
            tl.fromTo(c, { opacity: 0 }, { opacity: 1, duration: 0.4, immediateRender: false }, t);
            const zoom = c.querySelector(".zoom");
            if (zoom) tl.fromTo(zoom, { scale: 1 }, { scale: 1.08, duration: show, ease: "none", immediateRender: false }, t);
            tl.to(c, { opacity: 0, duration: 0.4 }, t + show - 0.4);
            tl.fromTo(label, { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.4, immediateRender: false }, t + 0.2);
            tl.to(label, { opacity: 0, duration: 0.3 }, t + show - 0.4);
          });
        });
      </script>`;
}

// A still from the newest final (or the draft) for the home page strip; cached per source render.
export async function poster(job) {
  const src = job.finals?.at(-1) ?? job.draft;
  if (!src) return null;
  const out = path.join(projectDir(job), "renders", `poster-${src.replace(".mp4", "")}.jpg`);
  if (!fs.existsSync(out)) await sh("ffmpeg", ["-loglevel", "error", "-y", "-ss", String(job.bumpers === false ? 3 : BUMPER.open + 3), "-i", path.join(projectDir(job), "renders", src), "-frames:v", "1", "-vf", "scale=960:-1", "-q:v", "4", out]);
  return out;
}

// Downloads of a final: a smaller size and a choice of subtitle tracks, made by ffmpeg once and cached.
// Subtitles already shown on the picture are part of the image and stay whatever is picked here.
export const QUALITIES = { original: null, 720: 720, 480: 480 };
// subs: "all", "none", or the index of the one subtitle track to keep
export function downloadArgs(src, out, q, subs, vertical) {
  const short = QUALITIES[q];
  const subMap = subs === "all" ? ["-map", "0:s?"] : subs === "none" ? [] : ["-map", `0:s:${subs}`];
  const video = short ? ["-vf", vertical ? `scale=${short}:-2` : `scale=-2:${short}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p"] : ["-c:v", "copy"];
  return ["-loglevel", "error", "-y", "-i", src, "-map", "0:v", "-map", "0:a?", ...subMap, ...video, "-c:a", "copy", "-c:s", "copy", "-movflags", "+faststart", out];
}
export async function download(job, name, q, subs) {
  const src = path.join(projectDir(job), "renders", name);
  if (q === "original" && subs === "all") return src;
  const out = path.join(projectDir(job), "renders", "downloads", `${name.replace(".mp4", "")}-${q}-${subs}.mp4`);
  if (!fs.existsSync(out)) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const tmp = `${out}.${process.pid}-${Date.now()}.mp4`; // two clicks at once never share a half-written file
    let pick = subs;
    if (!["all", "none"].includes(subs)) {
      // Older versions may have other tracks than the story has now, so look in the file itself.
      const { stdout } = await sh("ffprobe", ["-v", "error", "-select_streams", "s", "-show_entries", "stream_tags=language", "-of", "csv=p=0", src]);
      pick = stdout.trim().split("\n").indexOf(LANGS[subs].iso3);
      if (pick < 0) throw new Error(`This version has no ${LANGS[subs].name} subtitles`);
    }
    await sh("ffmpeg", downloadArgs(src, tmp, q, pick, job.format === "vertical"));
    fs.renameSync(tmp, out);
  }
  return out;
}

// The same still as the poster, full size, for YouTube; cached per source render.
export async function thumbnail(job) {
  const src = job.finals?.at(-1) ?? job.draft;
  if (!src) return null;
  const out = path.join(projectDir(job), "renders", `thumb-${src.replace(".mp4", "")}.jpg`);
  if (!fs.existsSync(out)) await sh("ffmpeg", ["-loglevel", "error", "-y", "-ss", String(job.bumpers === false ? 3 : BUMPER.open + 3), "-i", path.join(projectDir(job), "renders", src), "-frames:v", "1", "-q:v", "2", out]);
  return out;
}

// Title, description, tags and social captions for the finished story, written from the approved script only.
export const DISCLOSURE = "AI presenter. Verified by the Dashavani desk.";
export const PublishPack = z.object({
  youtube_title: z.string().min(1).max(100),
  youtube_description: z.string().min(1).max(4500), // YouTube allows 5000; room for the disclosure and link
  tags: z.array(z.string().max(60)).max(15),
  hashtags: z.array(z.string().regex(/^#\S+$/)).max(5),
  instagram_caption: z.string().min(1).max(2000),
  x_post: z.string().min(1).max(280),
});
const PUBLISH = `You write the publishing text for a finished Dashavani news video: a YouTube title and description, search tags, hashtags, an Instagram caption and an X post.
Use only facts in the script and source given; add no claim, number or name that is not there. Write in the language you are told.
- youtube_title: at most 90 characters, plain and factual, no clickbait, no ALL CAPS sentences.
- youtube_description: 2 to 4 short paragraphs summarising the story. Do not add a disclosure or links; they are added for you.
- tags: up to 12 search phrases. hashtags: up to 4, each starting with #, no spaces.
- instagram_caption: 2 to 3 sentences, then the hashtags. x_post: at most 240 characters.`;
export async function publishPack(job) {
  const s = job.script;
  const pack = MOCK
    ? { youtube_title: s.headline.slice(0, 100), youtube_description: `${s.standfirst || s.headline}\n\n(Mock mode: description not written.)`, tags: ["Dashavani", s.category], hashtags: ["#Dashavani"], instagram_caption: `${s.headline} #Dashavani`, x_post: s.headline.slice(0, 280) }
    : await gemini(job, PUBLISH, `Language: ${LANGS[job.lang].name}\nScript:\n${JSON.stringify(s, null, 2)}\n\nSource:\n${job.input}`, PublishPack, "publish pack");
  // The disclosure and source link are added here, not left to the model.
  pack.youtube_description = [pack.youtube_description.trim(), DISCLOSURE, job.source?.url && `Source: ${job.source.url}`].filter(Boolean).join("\n\n");
  return pack;
}

// Where "Back" goes: the review stage before the current one (null = nowhere to go back to).
// Review stops in order, each with what must already exist to stand on it; and where each status sits among them.
const STOPS = [["script_review", (j) => j.script], ["voice_review", (j) => j.voice], ["draft_review", (j) => j.draft]];
const STOP_AT = { fixlang: 3, edit: 3, script: 0, script_review: 0, voice: 1, voice_review: 1, compose: 2, draft: 2, draft_review: 2, avatar: 3, final: 3, publish: 3, youtube: 3, done: 3 };
// Earlier review stops a person can go back to, nearest last. None while a step runs.
export function backTargets(job) {
  // An error names the step that failed; one that stopped while still queued is judged by the step it was waiting for.
  const failed = job.status === "error" ? job.error?.split(":")[0] : job.status;
  const at = failed === "queued" ? job.pending?.steps?.[0] ?? failed : failed;
  if (job.status !== "error" && job.status !== "done" && !job.status.endsWith("_review")) return [];
  return STOPS.slice(0, STOP_AT[at] ?? 0).filter(([, has]) => has(job)).map(([stop]) => stop);
}

// Sets each declared variable's default. Handles both the hand-written ('…') and Studio-saved ("&quot;…") forms.
export function fillVariables(html, values) {
  const re = /data-composition-variables=(?:'([^']*)'|"([^"]*)")/;
  if (!re.test(html)) throw new Error("Template has no data-composition-variables");
  return html.replace(re, (_, single, double) => {
    const raw = single ?? double;
    const decl = JSON.parse(raw.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
    for (const d of decl) if (d.id in values) d.default = values[d.id];
    return `data-composition-variables="${JSON.stringify(decl).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`;
  });
}

function setAttr(html, tagRe, attr, value) {
  const tag = html.match(tagRe)?.[0];
  if (!tag) throw new Error(`Template is missing ${tagRe}`);
  const re = new RegExp(`\\s${attr}="[^"]*"`);
  if (!re.test(tag)) throw new Error(`Template tag has no ${attr}: ${tag.slice(0, 80)}`);
  return html.replace(tag, tag.replace(re, ` ${attr}="${value}"`));
}

// Who asked for the work in progress (owner-only steps check it): the server runs each request and queued job
// inside useKeys.run({ owner }, ...). Every account's work uses the API keys in the server's .env.local.
export const useKeys = new AsyncLocalStorage();
function need(name) {
  if (!process.env[name]) throw new Error(`${name} is not set in .env.local`);
  return process.env[name];
}
