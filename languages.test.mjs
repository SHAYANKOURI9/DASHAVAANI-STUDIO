// Every language the studio offers must be complete everywhere it is used: pipeline, video fonts, the page, PIB.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { LANGS, TEMPLATES, voiceFor } from "./pipeline.mjs";
import { LANG_NAMES } from "./pib.mjs";

const WANTED = ["en", "te", "hi", "ta", "kn", "ml", "mr", "bn", "gu", "or"];

test("the studio offers English, Telugu, Hindi and the seven new languages", () => {
  assert.deepEqual(Object.keys(LANGS).sort(), [...WANTED].sort());
});

test("each language has a name, a badge in its own script, codes for ElevenLabs and MP4 tracks, and a voice", () => {
  for (const [k, l] of Object.entries(LANGS)) {
    assert.ok(l.name && l.badge, k);
    assert.equal(l.code, k, `${k}: ElevenLabs language_code`);
    assert.match(l.iso3, /^[a-z]{3}$/, `${k}: ISO 639-2 code for subtitle tracks`);
    assert.match(voiceFor(k), /^\w{20}$/, `${k}: a voice id`);
  }
  assert.equal(LANGS.or.iso3, "ori");
  assert.equal(LANGS.mr.font, "Noto Sans Devanagari", "Marathi is written in Devanagari");
});

test("every video template loads a font for every script, and the font file is there", () => {
  const dirs = [...Object.values(TEMPLATES), "vt05-shorts"];
  for (const dir of dirs) {
    const html = fs.readFileSync(path.join("templates", dir, "index.html"), "utf8");
    for (const [k, { font }] of Object.entries(LANGS)) {
      if (!font) continue;
      const face = html.match(new RegExp(`@font-face \\{ font-family: "${font}"; src: url\\("([^"]+)"\\)`));
      assert.ok(face, `${dir}: no @font-face for ${font} (${k})`);
      assert.ok(fs.existsSync(path.join("templates", dir, face[1])), `${dir}: ${face[1]} missing`);
      assert.ok(html.includes(`"${font}", sans-serif`) || html.includes(`"${font}",`), `${dir}: ${font} is not in a font stack`);
    }
  }
});

test("the studio page and the PIB source list every language", () => {
  const app = fs.readFileSync("web/src/app.js", "utf8"), page = fs.readFileSync("web/index.html", "utf8");
  for (const k of Object.keys(LANGS)) {
    assert.match(app, new RegExp(`\\b${k}: \\[`), `app.js LANG has ${k}`);
    assert.match(page, new RegExp(`name="lang" id="lang-${k}" value="${k}"`), `filing form offers ${k}`);
    assert.equal(LANG_NAMES[k], LANGS[k].name, `PIB name for ${k}`);
  }
});
