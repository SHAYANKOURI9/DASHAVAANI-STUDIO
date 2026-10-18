// Hero background: a tilted wall of stills and headline cards, its columns drifting in opposite directions.
// Pictures dropped into web/src/wall/ are added at build time.
import { t } from "./i18n.js";

const OWN = Object.values(import.meta.glob("./wall/*.{jpg,jpeg,png,webp,avif}", { eager: true, query: "?url", import: "default" }));
const COLS = 7, PER_COL = 6;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

let key = "";
export function buildWall(el, urls, stories) {
  const images = [...OWN, ...urls];
  const next = JSON.stringify([images, stories.map((s) => s.headline)]);
  if (next === key || !images.length) return;
  key = next;
  let n = 0;
  const card = (c, r) => {
    // Every few cards is a headline instead of a picture, so the wall reads as a newsroom, not a gallery.
    const s = stories.length && (c + r) % 4 === 2 ? stories[(c * PER_COL + r) % stories.length] : null;
    if (s) return `<div class="wcard text" translate="no"><span class="cat">${esc(s.category || t("News"))}</span><p lang="${esc(s.lang)}">${esc(s.headline)}</p></div>`;
    return `<div class="wcard"><img src="${images[n++ % images.length]}" alt="" loading="lazy" decoding="async"></div>`;
  };
  el.innerHTML = `<div class="plane">${Array.from({ length: COLS }, (_, c) => {
    const cards = Array.from({ length: PER_COL }, (_, r) => card(c, r)).join("");
    // Each column holds its cards twice and scrolls by half its height, so the loop has no seam.
    return `<div class="wcol" style="--t:${70 + (c % 3) * 14}s;--dir:${c % 2 ? "reverse" : "normal"}"><div class="wrun">${cards}${cards}</div></div>`;
  }).join("")}</div>`;
}
