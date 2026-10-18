// Verified story sources. A source needs: name, an id pattern, url(id), list() and item(id, lang); photos(id, lang) and photoHost are optional.
// To add PTI (or any agency), add one entry here once its feed, credentials and licence exist.
import * as PIB from "./pib.mjs";

export const SOURCES = {
  pib: {
    name: "PIB",
    fullName: "Press Information Bureau",
    idPattern: /^\d{4,9}$/,
    url: (id) => `https://pib.gov.in/PressReleasePage.aspx?PRID=${id}`,
    list: async () => (await PIB.inbox()).map((i) => ({ id: i.prid, title: i.title })),
    item: async (id, lang) => {
      const r = await PIB.releaseFor(id, lang);
      return { id: r.prid, title: r.title, publisher: r.ministry, date: r.date, body: r.body, original: r.original };
    },
    // Photos published with the release; the original release when the language version has none.
    photos: async (id, lang) => {
      const r = await PIB.releaseFor(id, lang);
      return r.images.length || !r.original ? r.images : (await PIB.releaseFor(r.original, "en")).images;
    },
    photoHost: "static.pib.gov.in",
  },
};

// One failing source must not hide the others, so errors are reported per source.
// lang: the editor's interface language; titles are shown in it, with the original kept for the story itself.
export async function inbox(lang = "en", opts) {
  const items = [], errors = [];
  await Promise.all(Object.entries(SOURCES).map(async ([key, s]) => {
    try { items.push(...(await s.list()).map((i) => ({ ...i, source: key, sourceName: s.name, url: s.url(i.id) }))); }
    catch (e) { errors.push({ source: s.name, message: e.message }); }
  }));
  if (lang !== "en" && opts) {
    const shown = await localTitles(items.map((i) => i.title), lang, opts);
    items.forEach((i, n) => Object.assign(i, { original: i.title, title: shown[n] }));
  }
  return { items, errors };
}

// Wire headlines in another language. Each headline is translated once per language (cache), only new ones are
// sent, and any failure or wrong-length answer shows the English headlines instead of nothing.
export async function localTitles(titles, lang, { cache, translate }) {
  if (lang === "en") return titles;
  const key = (t) => `${lang}\u0000${t}`;
  const todo = [...new Set(titles.filter((t) => !cache[key(t)]))];
  if (todo.length) {
    const out = await translate(todo, lang).catch(() => null);
    if (out?.length === todo.length) todo.forEach((t, n) => { cache[key(t)] = out[n]; });
  }
  return titles.map((t) => cache[key(t)] ?? t);
}

// A story source from the client is accepted only as a known source plus a valid id and a title; the link is rebuilt here.
export function validSource(src) {
  const s = SOURCES[src?.source];
  if (!s || !s.idPattern.test(src.id ?? "") || typeof src.title !== "string") return null;
  return { source: src.source, name: s.name, id: src.id, title: src.title.slice(0, 300), url: s.url(src.id) };
}
