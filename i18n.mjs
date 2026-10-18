// Interface translations. `npm run i18n` collects every interface line (t("…") in the page code, the static text of
// the two pages, the server's plain error messages) into web/src/i18n/keys.json, then has Gemini translate only the
// lines a language file does not have yet, so a line corrected by hand is never overwritten.
import fs from "node:fs";
import { createRequire } from "node:module";
import { z } from "zod";
import { gemini } from "./pipeline.mjs";
import { UI_LANGS, norm, placeholders } from "./web/src/i18n-core.js";

const DIR = "web/src/i18n";
const hasWords = (s) => /[A-Za-z]{2}/.test(s); // skips numbers, symbols and names already written in Indian scripts

// t("…") keys: plain string literals only (the page code never builds a key).
function codeKeys() {
  const out = [];
  for (const f of fs.readdirSync("web/src").filter((f) => /\.(js|tsx)$/.test(f) && !f.startsWith("i18n"))) {
    for (const m of fs.readFileSync(`web/src/${f}`, "utf8").matchAll(/\bt\(\s*(["'])((?:\\.|(?!\1).)*)\1/g)) {
      out.push(JSON.parse(`"${m[2].replace(/\\'/g, "'").replace(/(?<!\\)"/g, '\\"')}"`));
    }
  }
  return out;
}

// The server's own messages that reach the page as they are (no values built in).
function serverKeys() {
  const out = [];
  for (const f of ["server.mjs", "designer.mjs", "youtube.mjs", "users.mjs"]) {
    const src = fs.readFileSync(f, "utf8");
    for (const re of [/return "([^"\\]+)"/g, /error: "([^"\\]+)"/g, /new Error\("([^"\\$]+)"\)/g]) for (const m of src.matchAll(re)) out.push(m[1]);
  }
  return out;
}

// Static page text, read the way web/src/i18n.js reads it: text nodes and a few attributes, outside translate="no".
async function pageKeys() {
  const puppeteer = createRequire(import.meta.url)("puppeteer-core");
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const out = [];
  for (const file of ["web/index.html", "web/intro.html", "web/login.html"]) {
    const page = await browser.newPage();
    await page.setContent(fs.readFileSync(file, "utf8").replace(/<script\b[\s\S]*?<\/script>/g, ""));
    out.push(...(await page.evaluate(() => {
      const skip = (el) => el?.closest('[translate="no"], script, style, textarea');
      const found = [document.title];
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n; (n = walk.nextNode());) if (!skip(n.parentElement)) found.push(n.nodeValue);
      for (const el of document.querySelectorAll("[placeholder],[aria-label],[title],[alt]")) {
        if (!skip(el)) for (const a of ["placeholder", "aria-label", "title", "alt"]) if (el.hasAttribute(a)) found.push(el.getAttribute(a));
      }
      return found;
    })));
  }
  await browser.close();
  return out;
}

async function extract() {
  const keys = [...new Set([...codeKeys(), ...serverKeys(), ...(await pageKeys())].map(norm).filter(hasWords))].sort();
  fs.writeFileSync(`${DIR}/keys.json`, `${JSON.stringify(keys, null, 1)}\n`);
  console.log(`${keys.length} interface lines in ${DIR}/keys.json`);
  return keys;
}

const KEEP = "Dashavani, Dashavani Studio, HeyGen, ElevenLabs, Gemini, HyperFrames, YouTube, PIB, Instagram, X, Shorts & Reels, MP4, SRT, JPG, 16:9, 9:16, IST, AI";
const SYSTEM = (lang) => `You translate the interface of Dashavani Studio, a newsroom tool that turns verified news releases into broadcast videos, from English into ${lang}.
The lines are buttons, labels, hints, statuses and messages that an editor reads while working.
- Translate every line, in order: the answer has exactly as many lines as the question.
- Keep every {placeholder} exactly as written (same braces, same name); move it to where it belongs in a natural ${lang} sentence.
- Keep these names as they are: ${KEEP}.
- Write the way an Indian newsroom in ${lang} actually speaks: plain and direct; an English word that ${lang} speakers commonly use (video, script, template) is fine.
- Keep it as short as the English; no added politeness, no explanations, no quotation marks around the line.
- Keep any HTML entity or symbol (&amp;, ·, ₹, %, →) as it is.`;
const Lines = z.object({ lines: z.array(z.string()) });

async function translate(keys) {
  for (const [code, name] of Object.entries(UI_LANGS).filter(([c]) => c !== "en")) {
    const file = `${DIR}/${code}.json`;
    const have = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    const todo = keys.filter((k) => !have[k]?.trim());
    const lang = { or: "Odia" }[code] ?? new Intl.DisplayNames(["en"], { type: "language" }).of(code);
    for (let i = 0; i < todo.length; i += 40) {
      const batch = todo.slice(i, i + 40);
      for (let attempt = 1; ; attempt++) {
        // A busy Gemini skips this batch (the next run fills it in) instead of stopping every language.
        const answer = await gemini({}, SYSTEM(lang), batch.map((k, n) => `${n + 1}. ${k}`).join("\n"), Lines, `${name} interface`).catch((e) => { console.error(`${name}: skipped ${batch.length} lines (${e.message.split(".")[0]})`); return null; });
        if (!answer) break;
        const { lines } = answer;
        const clean = lines.map((l) => l.replace(/^\s*\d+[.)]\s*/, "").trim());
        const bad = clean.length !== batch.length ? `${clean.length} lines for ${batch.length}` : batch.find((k, n) => placeholders(k).join() !== placeholders(clean[n]).join());
        if (!bad) { batch.forEach((k, n) => { have[k] = clean[n]; }); break; }
        if (attempt === 3) throw new Error(`${name}: Gemini kept getting a batch wrong (${bad})`);
      }
      fs.writeFileSync(file, `${JSON.stringify(Object.fromEntries(keys.filter((k) => have[k]).map((k) => [k, have[k]])), null, 1)}\n`);
      console.log(`${name}: ${Math.min(i + 40, todo.length)} of ${todo.length} new lines`);
    }
    if (!todo.length) console.log(`${name}: up to date`);
  }
}

const keys = await extract();
if (process.argv[2] !== "extract") await translate(keys);
