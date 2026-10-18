// Press Information Bureau (Govt of India) releases: the verified story source for v1.
// Lang=1 English, Reg=3 the national (Delhi) desk. PIB ignores "Regid" and falls back to Hindi, so the name matters.
const FEED = "https://pib.gov.in/RssMain.aspx?ModId=6&Reg=3&Lang=1";
const PAGE = "https://pib.gov.in/PressReleasePage.aspx?PRID=";
const UA = { "User-Agent": "Mozilla/5.0 (Dashavani Studio)" };
// The language names PIB uses in its "Read this release in" links.
export const LANG_NAMES = { en: "English", te: "Telugu", hi: "Hindi", ta: "Tamil", kn: "Kannada", ml: "Malayalam", mr: "Marathi", bn: "Bengali", gu: "Gujarati", or: "Odia" };

const unescape = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(n)).replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");

export function parseFeed(xml) {
  return [...xml.matchAll(/<item>\s*<title>([\s\S]*?)<\/title>\s*<link>([\s\S]*?)<\/link>/g)]
    .map(([, title, link]) => ({ title: unescape(title.trim()), prid: link.match(/PRID=(\d+)/)?.[1] }))
    .filter((i) => i.prid && i.title)
    .filter((i, n, all) => all.findIndex((j) => j.prid === i.prid) === n);
}

export function parseRelease(html, prid) {
  const at = html.indexOf("innner-page-main-about-us-content-right-part");
  if (at < 0) throw new Error(`PIB release ${prid} has an unexpected page layout`);
  const page = html.slice(at);
  const field = (id) => unescape(page.match(new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)</`))?.[1]?.replace(/<[^>]+>/g, "").trim() ?? "");
  // Body: everything after the date line up to PIB's "***" end marker, as plain text lines.
  const text = unescape(page.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "").replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h\d>/gi, "\n").replace(/<[^>]+>/g, ""));
  const lines = text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const start = lines.findIndex((l) => / by PIB /.test(l)) + 1;
  const end = lines.findIndex((l, i) => i >= start && /^\*{3}$/.test(l));
  const body = lines.slice(start, end > 0 ? end : start + 60).join("\n");
  // Story photos only: PIB uploads them under userfiles/image; site graphics live elsewhere.
  const images = [...new Set([...page.matchAll(/<img[^>]+src=["']([^"']*\/WriteReadData\/userfiles\/image\/[^"']+\.(?:jpe?g|png|webp))["']/gi)].map((m) => new URL(m[1], "https://static.pib.gov.in/").href))];
  const languages = Object.fromEntries([...(page.match(/class="ReleaseLang"[\s\S]*?<\/div>/)?.[0] ?? "").matchAll(/PRID=(\d+)'[^>]*>\s*([^<]+?)\s*</g)].map(([, id, name]) => [name, id]));
  return {
    prid, url: PAGE + prid,
    ministry: field("MinistryName"), title: field("Titleh2"),
    date: field("PrDateTime").replace(/^[^:]*:\s*/, ""),
    body, languages, images,
  };
}

let feed = { at: 0, items: [] };
export async function inbox() {
  if (Date.now() - feed.at > 5 * 60_000) {
    const res = await fetch(FEED, { headers: UA });
    if (!res.ok) throw new Error(`PIB feed ${res.status}`);
    feed = { at: Date.now(), items: parseFeed(await res.text()).slice(0, 30) };
  }
  return feed.items;
}

const releases = new Map();
async function release(prid) {
  if (!releases.has(prid)) {
    const res = await fetch(PAGE + prid, { headers: UA });
    if (!res.ok) throw new Error(`PIB release ${prid}: ${res.status}`);
    releases.set(prid, parseRelease(await res.text(), prid));
  }
  return releases.get(prid);
}

// The release in the edition's language when PIB published one, otherwise the original.
export async function releaseFor(prid, lang) {
  const original = await release(prid);
  const other = original.languages[LANG_NAMES[lang]];
  return other && other !== prid ? { ...(await release(other)), original: prid } : original;
}
