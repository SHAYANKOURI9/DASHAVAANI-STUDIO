// The studio's own text in the editor's language. The English text is the key; each language file
// (web/src/i18n/<code>.json) maps it to a translation. Placeholders like {n} keep word order free per language.
export const UI_LANGS = { en: "English", te: "తెలుగు", hi: "हिन्दी", ta: "தமிழ்", kn: "ಕನ್ನಡ", ml: "മലയാളം", mr: "मराठी", bn: "বাংলা", gu: "ગુજરાતી", or: "ଓଡ଼ିଆ" };

export const norm = (s) => s.replace(/\s+/g, " ").trim();
export const placeholders = (s) => [...String(s ?? "").matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)) : s);
export const makeT = (catalog) => (en, vars) => fill(catalog[en] || en, vars);

// A piece of page text, translated if the table has it; the spaces around it stay as they were.
export function translateText(raw, catalog) {
  const [, lead, body, trail] = raw.match(/^(\s*)([\s\S]*?)(\s*)$/);
  const tr = body && catalog[norm(body)];
  return tr ? lead + tr + trail : raw;
}
