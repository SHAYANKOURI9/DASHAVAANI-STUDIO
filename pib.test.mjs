import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeed, parseRelease } from "./pib.mjs";

test("feed: items with release ids, duplicates dropped, entities decoded", () => {
  const xml = `<rss><channel><title>PIB</title>
    <item><title>Rate &amp; policy</title><link>https://pib.gov.in/PressReleaseIframePage.aspx?PRID=11</link></item>
    <item><title>Rate &amp; policy</title><link>https://pib.gov.in/PressReleaseIframePage.aspx?PRID=11</link></item>
    <item><title>No id</title><link>https://pib.gov.in/</link></item></channel></rss>`;
  assert.deepEqual(parseFeed(xml), [{ title: "Rate & policy", prid: "11" }]);
});

test("release: title, ministry, body up to the *** marker, language versions", () => {
  const html = `<div class="innner-page-main-about-us-content-right-part"><div id="MinistryName" class="x"> Ministry of Finance </div>
    <h1 id="Titleh2"> Repo rate unchanged </h1><div id="PrDateTime" class="y"> Posted On: 08 OCT 2026 10:04PM by PIB Delhi </div>
    <img src="https://static.pib.gov.in/WriteReadData/specificdocs/photo/2026/sep/banner.png"><p>First paragraph.</p>
    <img src="https://static.pib.gov.in/WriteReadData/userfiles/image/2026/oct/image001_1.jpg"><img src='https://static.pib.gov.in/WriteReadData/userfiles/image/2026/oct/image001_1.jpg'>
    <p>Second &amp; last.</p><p>***</p><p>footer junk</p>
    <div class="ReleaseLang">Read this release in: <a href='https://pib.gov.in/PressReleasePage.aspx?PRID=22' target="_blank"> Telugu </a></div></div>`;
  const r = parseRelease(html, "21");
  assert.equal(r.title, "Repo rate unchanged");
  assert.equal(r.ministry, "Ministry of Finance");
  assert.equal(r.body, "First paragraph.\nSecond & last.");
  assert.deepEqual(r.languages, { Telugu: "22" });
  assert.deepEqual(r.images, ["https://static.pib.gov.in/WriteReadData/userfiles/image/2026/oct/image001_1.jpg"]); // banner dropped, duplicate once
  assert.equal(r.url, "https://pib.gov.in/PressReleasePage.aspx?PRID=21");
});
