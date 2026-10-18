// Template designer: a new look for an existing template, described in words. Gemini writes style changes only;
// the brand check keeps them to the house palette, keeps the AI disclosure visible and lets nothing load from outside.
// Every new look starts as a draft with a preview; only approved looks reach the template picker.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import * as P from "./pipeline.mjs";

const sh = promisify(execFile);
const WIN = process.platform === "win32";
const npx = (args, opts = {}) => sh(WIN ? "npx.cmd" : "npx", args, { ...opts, shell: WIN });

// Dashavani colours: navy, studio blue, paper, gold, red, warm grey, white.
export const PALETTE = ["#16204a", "#222e63", "#f3ede2", "#f0a202", "#c9301a", "#d9d3c6", "#ffffff"];
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(",");
const NAMED = /:\s*[^;{}]*\b(red|blue|green|yellow|purple|pink|orange|black|gr[ae]y|cyan|magenta|navy|gold|silver|maroon|teal|olive|lime|aqua|fuchsia)\b/i;

// Problems with a proposed style block, in plain words; empty means it passes.
export function lintCss(css) {
  const out = [];
  if (css.length > 4000) out.push("The style block is longer than 4000 characters");
  if (/url\s*\(|@import|@font-face|expression\s*\(|javascript:|<\s*\/?\s*(style|script)|behavior\s*:/i.test(css)) out.push("Styles may not load files, fonts or scripts (url(), @import, @font-face, script)");
  // Colours are only checked inside declarations, so ids such as #badge in selectors are never mistaken for colours.
  const values = [...css.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).join(";");
  for (const m of values.matchAll(/#([0-9a-f]{3,8})\b/gi)) {
    let hex = m[1].toLowerCase();
    if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
    if (!PALETTE.includes(`#${hex.slice(0, 6)}`)) out.push(`Colour #${m[1]} is not a Dashavani colour`);
  }
  for (const m of values.matchAll(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/gi)) { // rgb(1, 2, 3) and rgb(1 2 3)
    if (!PALETTE.some((hex) => rgbOf(hex) === `${m[1]},${m[2]},${m[3]}`) && `${m[1]},${m[2]},${m[3]}` !== "0,0,0") out.push(`Colour rgb(${m[1]}, ${m[2]}, ${m[3]}) is not a Dashavani colour`);
  }
  if (/hsla?\(|oklch\(|lab\(|lch\(|color\(/i.test(css)) out.push("Use Dashavani colours as hex or rgba, not other colour functions");
  if (NAMED.test(values.replace(/^/, ":"))) out.push("Use Dashavani colours by hex, not colour names");
  // The AI presenter label is a legal disclosure: it can be restyled but never hidden.
  for (const rule of css.matchAll(/([^{}]*)\{([^}]*)\}/g)) {
    if (/#disclosure|\.ai\b|#avatar|#panel/.test(rule[1]) && /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(\.0*)?\s*(!important\s*)?(;|$)/i.test(rule[2])) out.push("The AI presenter label and presenter must stay visible");
  }
  return [...new Set(out)];
}

const DESIGN = `You restyle a HyperFrames news video template for Dashavani. You get the template's current CSS and an editor's request.
Return only extra CSS rules that change the look as asked (colours, sizes, weights, spacing, borders, positions of existing elements).
Rules: use only these colours, as hex or rgba with these values: ${PALETTE.join(", ")} (plus rgba(0,0,0,a) for shadows).
No url(), @import, @font-face or new fonts; only the families already used. Use the existing ids and classes; prefix every selector with #root.
Never hide #disclosure, .ai, #panel or #avatar. Keep text inside the 1920x1080 frame. name: 2-4 words; description: one sentence of what changed.`;
const DesignShape = z.object({ name: z.string(), description: z.string(), css: z.string() });

export const CUSTOM = P.CUSTOM_TEMPLATES;
const metaPath = (id) => path.join(CUSTOM, id, "custom.json");
export const listTemplates = () => (fs.existsSync(CUSTOM) ? fs.readdirSync(CUSTOM).filter((d) => fs.existsSync(metaPath(d))).map((d) => JSON.parse(fs.readFileSync(metaPath(d), "utf8"))) : [])
  .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
const save = (meta) => fs.writeFileSync(metaPath(meta.id), JSON.stringify(meta, null, 2));

// Starts a draft and returns it at once (status "making"); the design, checks and preview finish in the background.
export function startDesign(base, request) {
  const id = `c-${randomBytes(4).toString("hex")}`;
  const dir = path.join(CUSTOM, id);
  fs.mkdirSync(dir, { recursive: true });
  const meta = { id, name: "New look", description: "", from: base, base: P.baseOf(base), request, status: "making", createdAt: new Date().toISOString() };
  save(meta);
  design(meta, dir).catch((e) => { Object.assign(meta, { status: "error", error: e.message }); save(meta); });
  return meta;
}

async function design(meta, dir) {
  const html = fs.readFileSync(path.join(P.templateDirOf(meta.from), "index.html"), "utf8");
  const baseCss = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
  let out, problems = [];
  // One retry with the brand check's findings, then give up with them.
  for (let attempt = 0; attempt < 2; attempt++) {
    out = P.MOCK ? { name: "Gold headline", description: "The headline is set in gold.", css: "#root #headline { color: #f0a202; }" }
      : await P.gemini({}, DESIGN, `Request: ${meta.request}\n${problems.length ? `\nYour last answer failed these checks, fix them: ${problems.join("; ")}\n` : ""}\nCurrent CSS:\n${baseCss}`, DesignShape, "template design");
    problems = lintCss(out.css);
    if (!problems.length) break;
  }
  if (problems.length) throw new Error(`The new look did not pass the brand check: ${problems.join("; ")}`);
  fs.cpSync(P.templateDirOf(meta.from), dir, { recursive: true, filter: (src) => !/[/\\](\.hyperframes|\.thumbnails|snapshots|renders|custom\.json|preview\.jpg)$/.test(src) });
  fs.writeFileSync(path.join(dir, "index.html"), html.replace("</head>", `<style id="dv-custom">\n${out.css}\n</style>\n</head>`));
  const lint = await npx(["hyperframes", "lint"], { cwd: dir }).catch((e) => ({ stdout: `${e.stdout ?? ""}${e.stderr ?? ""}` }));
  if (!/0 errors/.test(lint.stdout)) throw new Error(`HyperFrames check failed: ${lint.stdout.split("\n").filter((l) => /error/i.test(l)).slice(0, 3).join(" ")}`);
  const snaps = path.join(dir, "snapshots");
  await npx(["hyperframes", "snapshot", "--at", "3", "--no-end", "--describe", "false", "-o", snaps, "."], { cwd: dir, maxBuffer: 16 << 20 });
  const png = fs.readdirSync(snaps).find((f) => f.endsWith(".png"));
  await sh("ffmpeg", ["-loglevel", "error", "-y", "-i", path.join(snaps, png), "-vf", "scale=960:-1", "-q:v", "4", path.join(dir, "preview.jpg")]);
  fs.rmSync(snaps, { recursive: true, force: true });
  Object.assign(meta, { name: out.name.slice(0, 40), description: out.description.slice(0, 200), css: out.css, status: "draft" });
  save(meta);
}

// Approve (it joins the picker) or reject (it is deleted).
export function setStatus(id, status) {
  if (!/^c-[a-f0-9]{8}$/.test(id) || !fs.existsSync(metaPath(id))) return "No such template";
  const meta = JSON.parse(fs.readFileSync(metaPath(id), "utf8"));
  if (meta.status === "making") return "This look is still being made; reject it once it is ready"; // deleting now would break or resurrect it
  if (status === "rejected") { fs.rmSync(path.join(CUSTOM, id), { recursive: true, force: true }); return null; }
  if (status !== "approved" || meta.status !== "draft") return "Only a finished draft can be approved";
  meta.status = "approved";
  save(meta);
  return null;
}
