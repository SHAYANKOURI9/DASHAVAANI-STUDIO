import { test } from "node:test";
import assert from "node:assert/strict";
import { validSource } from "./sources.mjs";

test("a story source must be a known source with a valid id; the link is rebuilt, not trusted", () => {
  assert.deepEqual(validSource({ source: "pib", id: "2321131", title: "T", url: "https://evil.example" }),
    { source: "pib", name: "PIB", id: "2321131", title: "T", url: "https://pib.gov.in/PressReleasePage.aspx?PRID=2321131" });
  assert.equal(validSource({ source: "pti", id: "1", title: "T" }), null); // no PTI adapter until access exists
  assert.equal(validSource({ source: "pib", id: "abc", title: "T" }), null);
  assert.equal(validSource({ source: "pib", id: "2321131" }), null);
  assert.equal(validSource(undefined), null);
});

test("wire headlines in the editor's language: English untouched, each headline translated once, English on failure", async () => {
  const { localTitles } = await import("./sources.mjs");
  const calls = [];
  const translate = async (titles, lang) => { calls.push([lang, titles.length]); return titles.map((t) => `${lang}:${t}`); };
  const cache = {};
  assert.deepEqual(await localTitles(["A", "B"], "en", { cache, translate }), ["A", "B"]);
  assert.equal(calls.length, 0, "English needs no call");
  assert.deepEqual(await localTitles(["A", "B"], "te", { cache, translate }), ["te:A", "te:B"]);
  assert.deepEqual(await localTitles(["A", "B", "C"], "te", { cache, translate }), ["te:A", "te:B", "te:C"]);
  assert.deepEqual(calls, [["te", 2], ["te", 1]], "only the new headline is sent the second time");
  const broken = async () => { throw new Error("Gemini busy"); };
  assert.deepEqual(await localTitles(["D"], "ta", { cache, translate: broken }), ["D"], "a failure shows English, not nothing");
  const short = async () => ["only one"];
  assert.deepEqual(await localTitles(["E", "F"], "kn", { cache, translate: short }), ["E", "F"], "a wrong-length answer is not trusted");
  assert.equal(cache["kn\u0000E"], undefined, "nor cached");
});
