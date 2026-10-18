// Loads the chosen interface language before the page renders, and translates the page's static text.
// Story content (headlines, scripts, wire titles) sits inside translate="no" and is never touched.
import { UI_LANGS, makeT, translateText } from "./i18n-core.js";
export { UI_LANGS };

const KEY = "dv-ui-lang";
const saved = (() => { try { return localStorage.getItem(KEY); } catch { return null; } })();
export const uiLang = Object.hasOwn(UI_LANGS, saved ?? "") ? saved : "en";
const files = import.meta.glob("./i18n/[a-z][a-z].json", { import: "default" });
const catalog = uiLang === "en" ? {} : await (files[`./i18n/${uiLang}.json`]?.() ?? {});
export const t = makeT(catalog);

const ATTRS = ["placeholder", "aria-label", "title", "alt"];
export function translatePage(root = document.body) {
  if (uiLang === "en") return;
  const skip = (el) => el?.closest('[translate="no"], script, style, textarea');
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n; (n = walk.nextNode());) if (!skip(n.parentElement)) n.nodeValue = translateText(n.nodeValue, catalog);
  for (const el of root.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(","))) {
    if (skip(el)) continue;
    for (const a of ATTRS) if (el.hasAttribute(a)) el.setAttribute(a, translateText(el.getAttribute(a), catalog));
  }
}

// The menu: switching reloads, so every part of the page is drawn once in the new language.
export function mountLangMenu(select) {
  if (!select) return;
  select.innerHTML = Object.entries(UI_LANGS).map(([k, name]) => `<option value="${k}" lang="${k}" ${k === uiLang ? "selected" : ""}>${name}</option>`).join("");
  select.addEventListener("change", () => { try { localStorage.setItem(KEY, select.value); } catch {} location.reload(); });
}

document.documentElement.lang = uiLang; // lets the CSS drop letter-spacing, which breaks Indian scripts
document.title = t(document.title);
translatePage();
mountLangMenu(document.getElementById("ui-lang"));
