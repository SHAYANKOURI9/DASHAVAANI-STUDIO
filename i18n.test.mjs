import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { makeT, translateText, placeholders, UI_LANGS } from "./web/src/i18n-core.js";

test("t() looks up the English text, fills placeholders, and falls back to English", () => {
  const t = makeT({ "File a story": "కథనం ఫైల్ చేయండి", "{n} stories": "{n} కథనాలు" });
  assert.equal(t("File a story"), "కథనం ఫైల్ చేయండి");
  assert.equal(t("{n} stories", { n: 16 }), "16 కథనాలు");
  assert.equal(t("Not translated yet"), "Not translated yet");
  assert.equal(t("{n} left", { n: 0 }), "0 left", "zero is a value, not missing");
  assert.equal(t("{a} and {b}", { a: "x" }), "x and {b}", "a missing value stays visible, not blank");
});

test("page text is matched without its surrounding spaces, which are kept", () => {
  const cat = { "Write the script": "స్క్రిప్ట్ రాయండి" };
  assert.equal(translateText("\n    Write   the script  ", cat), "\n    స్క్రిప్ట్ రాయండి  ");
  assert.equal(translateText("Something else", cat), "Something else");
  assert.equal(translateText("   ", cat), "   ");
});

test("placeholders are listed so translations can be checked against them", () => {
  assert.deepEqual(placeholders("{left} of {limit} characters"), ["left", "limit"]);
  assert.deepEqual(placeholders("no values"), []);
});

test("every language has every line, with the same placeholders", () => {
  const keys = JSON.parse(fs.readFileSync("web/src/i18n/keys.json", "utf8"));
  assert.ok(keys.length > 100, "the studio has hundreds of lines to translate");
  for (const lang of Object.keys(UI_LANGS).filter((l) => l !== "en")) {
    const cat = JSON.parse(fs.readFileSync(`web/src/i18n/${lang}.json`, "utf8"));
    const missing = keys.filter((k) => !cat[k]?.trim());
    assert.deepEqual(missing.slice(0, 5), [], `${lang}: ${missing.length} lines not translated`);
    for (const k of keys) assert.deepEqual(placeholders(cat[k]), placeholders(k), `${lang}: placeholders changed in "${k}"`);
  }
});
