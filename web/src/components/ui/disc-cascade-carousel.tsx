"use client"

import * as React from "react"

/**
 * Disc Cascade Carousel — a film catalogue told in discs. Each title is a
 * printed disc on a slanted line that climbs out of the page toward you: the
 * one in the middle is the chosen film, the ones before it shrink away down
 * to the left, the next one looms large and half off the top right. Moving
 * through them, the line slides, every disc rolls like a wheel and swings into
 * its new pose a moment behind, and an editorial credits block (title,
 * directors, year, cast) and two press quotes change over with it.
 *
 * Built on the Tilt Cascade engine: one number, the position, chased by two
 * springs — a stiff one for the slide and a looser one for depth, turn and
 * roll. Drag, flick, sideways trackpad swipes, arrow keys, the Index menu and
 * the buttons all just move the target. Frames are written straight to the DOM
 * and stop when the springs settle.
 *
 * Disc labels are either your image (`src`) or generated here as SVG — six
 * patterns, a palette, the title set on an arc or in a block, fine print round
 * the rim — so the component needs no assets at all. React is the only import.
 */

export type DiscCredit = {
  /** Small caps on the left, e.g. "Directed by". */
  label: string
  /** Right-aligned. An array stacks one per line. */
  value: string | string[]
}

export type DiscReview = {
  /** Who said it, e.g. "The Evening Ledger". */
  source: string
  quote: string
  /** 0–5. Default 5. */
  stars?: number
}

export type DiscPattern = "sunburst" | "rings" | "halftone" | "horizon" | "stripes" | "eclipse" | "mosaic"

export type DiscCascadeItem = {
  /** The film's title: the big serif headline, and the disc print unless `label` says otherwise. */
  title: string
  credits?: DiscCredit[]
  reviews?: DiscReview[]
  /** Label art. Without one the label is generated from `pattern` and `palette`. */
  src?: string
  alt?: string
  /** Generated label pattern. Defaults by position. */
  pattern?: DiscPattern
  /** Generated label colours: background, figure, accent. */
  palette?: [string, string, string]
  /** Text printed on the disc. Defaults to `title`; "" prints nothing. */
  label?: string
  /** "arc" follows the top of the disc, "block" stacks it above the hub. */
  labelStyle?: "arc" | "block"
  /** Print colour on the disc. Defaults to black or white against the label. */
  ink?: string
  /** Fine print round the bottom rim. Defaults to the credits run together. */
  fine?: string
}

export type DiscNavLink = { label: string; href?: string }

export type DiscCascadeCarouselProps = {
  items: DiscCascadeItem[]
  /** Root height. **Must be a definite length.** */
  height?: string
  /** Diameter of the chosen disc, any CSS length. */
  discSize?: string
  /** Step along the line, as a fraction of the disc. */
  spacing?: number
  /** How far each step climbs, as a fraction of the disc. */
  rise?: number
  /** How far each step comes toward you, as a fraction of the disc. */
  depth?: number
  /** Turn of the chosen disc about its vertical axis, degrees. */
  yaw?: number
  /** Extra turn per step along the line, degrees. */
  fan?: number
  /** Lean of every disc, degrees. */
  tilt?: number
  /** Degrees a disc rolls per step travelled. */
  roll?: number
  /** Seconds per idle revolution of the chosen disc. 0 stops it. */
  spin?: number
  /** Strength of the moving glint, 0–1. */
  sheen?: number
  bounce?: number
  duration?: number
  loop?: boolean
  /** Milliseconds between automatic moves. 0 (default) is off. */
  autoplay?: number
  /** Wordmark at the top centre. "" hides it. Also printed small on generated discs. */
  brand?: string
  nav?: DiscNavLink[]
  /** Which nav link is current. */
  navActive?: number
  /** Label of the jump-to menu after the nav. "" hides it. */
  indexLabel?: string
  /** The credits block. */
  details?: boolean
  /** The press quotes. */
  reviews?: boolean
  /** Prev / counter / next. */
  controls?: boolean
  /** Bottom-left hint. "" hides it. */
  hint?: string
  /** A hairline frame inset from the edge. */
  frame?: boolean
  /** Root background, any CSS colour or gradient. */
  background?: string
  /** Text and hairlines. Defaults to the theme's foreground. */
  color?: string
  /** Headline and quotes. */
  serif?: string
  /** Nav, credits and controls. */
  sans?: string
  /** Disc print. */
  display?: string
  /** A stylesheet to load for the fonts, e.g. a Google Fonts URL. Nothing loads by default. */
  fontHref?: string | null
  index?: number
  defaultIndex?: number
  onIndexChange?: (index: number) => void
  /** Clicking (or Enter on) the disc that's already chosen. */
  onSelect?: (item: DiscCascadeItem, index: number) => void
  ariaLabel?: string
  className?: string
}

// #region motion
export function wrapIndex(i: number, n: number): number {
  if (n <= 0) return 0
  return ((i % n) + n) % n
}

/** The slide showing at a position. Without looping, a drag past an end still means the end slide. */
export function indexAt(pos: number, n: number, loop: boolean): number {
  if (n <= 0) return 0
  const i = Math.round(pos)
  return loop ? wrapIndex(i, n) : Math.min(Math.max(i, 0), n - 1)
}

/** Signed distance from the position to slide i, in slides. Looping takes the short way round. */
export function offsetOf(i: number, pos: number, n: number, loop: boolean): number {
  const d = i - pos
  return loop && n > 0 ? d - n * Math.round(d / n) : d
}

/** Past either end the line still follows a drag, at a third of the speed. */
export function rubber(pos: number, n: number): number {
  if (pos < 0) return pos / 3
  if (pos > n - 1) return n - 1 + (pos - (n - 1)) / 3
  return pos
}

/** Natural frequency and damping ratios from a framer-style bounce and duration. */
export function springOf(bounce: number, duration: number): { omega: number; slide: number; tilt: number } {
  const b = Math.min(Math.max(bounce, 0), 0.9)
  return { omega: (2 * Math.PI) / Math.max(duration, 0.1), slide: 1 - b / 2, tilt: 1 - b }
}

/** One semi-implicit Euler step, sub-stepped so a long frame can't blow it up. */
export function springStep(x: number, v: number, target: number, omega: number, zeta: number, dt: number): number[] {
  const steps = Math.max(1, Math.ceil(dt / (1 / 240)))
  const h = dt / steps
  for (let k = 0; k < steps; k++) {
    v += (-omega * omega * (x - target) - 2 * zeta * omega * v) * h
    x += v * h
  }
  return [x, v]
}

/** Where a released drag comes to rest: about a fifth of a second of the flick, at most three slides on. */
export function releaseTarget(pos: number, velocity: number, n: number, loop: boolean): number {
  const here = Math.round(pos)
  let t = Math.round(pos + velocity * 0.2)
  t = Math.min(Math.max(t, here - 3), here + 3)
  return loop ? t : Math.min(Math.max(t, 0), n - 1)
}

/** The nearest position showing slide i, from where the target is now. */
export function targetFor(i: number, target: number, n: number, loop: boolean): number {
  if (!loop) return Math.min(Math.max(i, 0), n - 1)
  const here = Math.round(target)
  let d = i - wrapIndex(here, n)
  d -= n * Math.round(d / n)
  return here + d
}

export type PoseConfig = { spacing: number; rise: number; depth: number; yaw: number; fan: number; roll: number }

/**
 * A disc's pose. `dx` is its distance from the sliding line, `d` from the
 * trailing spring. Position follows the line; depth, turn and roll follow the
 * trailing spring, which is what makes the discs swing. Discs coming toward
 * the viewer stop approaching three steps out so perspective can't explode.
 */
export function poseOf(dx: number, d: number, c: PoseConfig) {
  const near = Math.min(d, 2.2)
  return {
    x: dx * c.spacing,
    y: -dx * c.rise,
    z: near * c.depth,
    yaw: c.yaw + d * c.fan,
    roll: d * c.roll,
    zIndex: 100 + Math.round(d * 10),
    opacity: d < -2.5 ? Math.max(0, 1 - (-d - 2.5) / 1.2) : 1,
    hidden: dx < -4 || dx > 2.8,
  }
}
// #endregion

// #region art
/** Small deterministic PRNG, so a label is the same on every render and every server. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Black or white print against a hex background. Anything unparseable gets white. */
export function inkFor(bg: string): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(bg.trim())
  if (!m) return "#ffffff"
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1]
  const lin = (i: number) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  const L = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4)
  return L > 0.36 ? "#111111" : "#ffffff"
}

/** Greedy word wrap for the block label. A word longer than the line gets a line to itself. */
export function wrapLabel(text: string, max: number): string[] {
  const lines: string[] = []
  let cur = ""
  for (const w of text.trim().split(/\s+/)) {
    if (!w) continue
    if (cur && (cur + " " + w).length > max) {
      lines.push(cur)
      cur = w
    } else cur = cur ? cur + " " + w : w
  }
  if (cur) lines.push(cur)
  return lines
}

/** Font size (in the 200-unit disc) for `chars` condensed caps across `room` units, capped at `max`. */
export function fitSize(chars: number, room: number, max: number): number {
  return Math.max(6, Math.min(max, room / (Math.max(chars, 1) * 0.56)))
}

/** The width `chars` condensed caps take at size `fs`: what the label is pinned to whatever font arrives. */
export function textWidth(chars: number, fs: number): number {
  return Math.max(chars, 1) * fs * 0.56
}
// #endregion

const PATTERNS: DiscPattern[] = ["horizon", "mosaic", "eclipse", "sunburst", "halftone", "rings", "stripes"]
const PALETTES: [string, string, string][] = [
  ["#1b1d1f", "#3f6b3a", "#c9d6c4"],
  ["#f2e3c6", "#d2452b", "#2a5d8f"],
  ["#141414", "#e9e4da", "#c8a24a"],
  ["#f0c94c", "#e8572b", "#2b2622"],
  ["#e9e6df", "#1d1d1d", "#d84b3c"],
  ["#2d3f7a", "#e8b4c8", "#f4efe6"],
  ["#d9e3df", "#16443f", "#f08a5d"],
]

const CSS =
  ".dcc-root{position:relative;overflow:hidden;width:100%;container-type:inline-size;" +
  "color:var(--color-foreground,#1a1a1a);user-select:none;-webkit-user-select:none;touch-action:pan-y;" +
  "outline:none;-webkit-tap-highlight-color:transparent;--dcc-pad:clamp(16px,3.6cqw,44px)}" +
  ".dcc-root:focus-visible{box-shadow:inset 0 0 0 2px var(--color-primary,#171717)}" +
  ".dcc-root[data-dragging],.dcc-root[data-dragging] .dcc-slide{cursor:grabbing}" +
  ".dcc-frame{position:absolute;inset:calc(var(--dcc-pad) * .45);pointer-events:none;z-index:1;" +
  "border:1px solid color-mix(in oklab,currentColor 14%,transparent)}" +
  ".dcc-stage{position:absolute;left:50%;top:52%;width:var(--dcc-s);aspect-ratio:1/1;" +
  "transform:translate(-50%,-50%);perspective:calc(var(--dcc-s) * 3.2)}" +
  ".dcc-slide{position:absolute;inset:0;margin:0;padding:0;border:0;background:none;color:inherit;font:inherit;" +
  "border-radius:50%;cursor:pointer;will-change:transform;transform-style:preserve-3d;" +
  "-webkit-tap-highlight-color:transparent;outline:none}" +
  ".dcc-tilt{position:absolute;inset:0;transform-style:preserve-3d;transition:transform .5s cubic-bezier(.2,.7,.2,1)}" +
  ".dcc-slide[data-active] .dcc-tilt{transform:translateZ(var(--dcc-lift,0px)) " +
  "rotateX(calc(var(--dcc-py,0) * -12deg)) rotateY(calc(var(--dcc-px,0) * 12deg))}" +
  ".dcc-slide[data-active]:hover{--dcc-lift:calc(var(--dcc-s) * .05)}" +
  ".dcc-shade{position:absolute;inset:0;border-radius:50%;pointer-events:none;" +
  "transform:translate3d(0,7%,-18px) scale(.97);" +
  "background:radial-gradient(circle closest-side,transparent 30%,rgba(0,0,0,.2) 52%,rgba(0,0,0,.1) 80%,transparent 100%)}" +
  ".dcc-edge,.dcc-disc{position:absolute;inset:0;border-radius:50%;" +
  "-webkit-mask:radial-gradient(circle closest-side,transparent 16.6%,#000 17.1%);" +
  "mask:radial-gradient(circle closest-side,transparent 16.6%,#000 17.1%)}" +
  ".dcc-edge{transform:translateZ(-4px);background:linear-gradient(160deg,#d7d9dc,#8d9196 55%,#c4c7cb)}" +
  ".dcc-disc{overflow:hidden;background:#cfd2d6;" +
  "box-shadow:inset 0 0 0 1px rgba(255,255,255,.28),inset 0 0 0 2px rgba(0,0,0,.08)}" +
  ".dcc-roll,.dcc-idle{position:absolute;inset:0;border-radius:50%}" +
  ".dcc-roll{transform:rotate(var(--dcc-roll,0deg))}" +
  ".dcc-root[data-spin] .dcc-idle{animation:dcc-spin var(--dcc-spin) linear infinite;animation-play-state:paused}" +
  ".dcc-root[data-spin] .dcc-slide[data-active] .dcc-idle{animation-play-state:running}" +
  ".dcc-root[data-dragging] .dcc-slide .dcc-idle{animation-play-state:paused}" +
  "@keyframes dcc-spin{to{transform:rotate(1turn)}}" +
  ".dcc-idle>img{position:absolute;inset:0;width:100%;height:100%;max-width:none;display:block;object-fit:cover}" +
  ".dcc-idle>svg,.dcc-hub{position:absolute;inset:0;width:100%;height:100%;max-width:none;display:block;overflow:visible}" +
  ".dcc-hub{pointer-events:none}" +
  ".dcc-sheen{position:absolute;inset:0;border-radius:50%;pointer-events:none;mix-blend-mode:screen;opacity:var(--dcc-sheen);" +
  "background:conic-gradient(from calc(var(--dcc-glint,0deg) + var(--dcc-px,0) * 70deg)," +
  "transparent 0deg,rgba(255,255,255,.5) 16deg,transparent 38deg,transparent 140deg," +
  "rgba(150,215,255,.32) 168deg,rgba(255,170,225,.32) 186deg,rgba(255,236,170,.26) 200deg,transparent 224deg,transparent 360deg)," +
  "radial-gradient(circle at 32% 24%,rgba(255,255,255,.3),transparent 46%)}" +
  ".dcc-slide:focus-visible .dcc-disc{box-shadow:inset 0 0 0 3px var(--color-background,#fff),inset 0 0 0 6px var(--color-primary,#171717)}" +
  ".dcc-nav{position:absolute;top:calc(var(--dcc-pad) * .9);left:50%;transform:translateX(-50%);z-index:5;" +
  "display:flex;align-items:center;gap:clamp(12px,1.8cqw,22px);font-size:12px;white-space:nowrap}" +
  ".dcc-brand{font-weight:800;font-size:15px;letter-spacing:-.04em;margin-right:clamp(6px,1.4cqw,18px)}" +
  ".dcc-link{position:relative;color:inherit;text-decoration:none;opacity:.6;transition:opacity .2s;padding:4px 0}" +
  ".dcc-link:hover,.dcc-link[aria-current]{opacity:1}" +
  ".dcc-link[aria-current]::after{content:\"\";position:absolute;left:50%;bottom:-5px;width:3px;height:3px;margin-left:-1.5px;" +
  "border-radius:50%;background:currentColor}" +
  ".dcc-menu{position:relative}" +
  ".dcc-menubtn{display:inline-flex;align-items:center;gap:4px;margin:0;padding:4px 0;border:0;background:none;" +
  "color:inherit;font:inherit;cursor:pointer;opacity:.6;transition:opacity .2s}" +
  ".dcc-menubtn:hover,.dcc-menubtn[aria-expanded=true]{opacity:1}" +
  ".dcc-menubtn svg{transition:transform .25s}.dcc-menubtn[aria-expanded=true] svg{transform:rotate(180deg)}" +
  ".dcc-list{position:absolute;top:calc(100% + 10px);left:50%;transform:translateX(-50%);min-width:240px;margin:0;" +
  "padding:6px;list-style:none;border-radius:10px;" +
  "background:color-mix(in oklab,var(--color-background,#fff) 86%,transparent);" +
  "border:1px solid color-mix(in oklab,currentColor 12%,transparent);" +
  "-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);box-shadow:0 12px 32px -12px rgba(0,0,0,.28);" +
  "animation:dcc-drop .22s cubic-bezier(.2,.7,.2,1) both}" +
  "@keyframes dcc-drop{from{opacity:0;transform:translate(-50%,-6px)}}" +
  ".dcc-opt{display:flex;align-items:baseline;gap:10px;width:100%;margin:0;padding:7px 10px;border:0;border-radius:6px;" +
  "background:none;color:inherit;font:inherit;font-size:12px;text-align:left;cursor:pointer}" +
  ".dcc-opt:hover,.dcc-opt:focus-visible{outline:none;background:color-mix(in oklab,currentColor 8%,transparent)}" +
  ".dcc-opt[aria-current] .dcc-optt{font-weight:600}" +
  ".dcc-optn{font-size:10px;opacity:.45;font-variant-numeric:tabular-nums}" +
  ".dcc-opty{margin-left:auto;font-size:10px;opacity:.45}" +
  ".dcc-head{position:absolute;top:var(--dcc-pad);left:var(--dcc-pad);z-index:4;width:clamp(170px,21cqw,290px);pointer-events:none}" +
  ".dcc-title{margin:0 0 10px;font-weight:400;font-size:clamp(20px,2.5cqw,34px);line-height:.98;" +
  "letter-spacing:-.01em;text-transform:uppercase;text-wrap:balance}" +
  ".dcc-dl{margin:0}" +
  ".dcc-row{display:flex;justify-content:space-between;gap:12px;padding:5px 0 6px;" +
  "border-top:1px solid color-mix(in oklab,currentColor 55%,transparent)}" +
  ".dcc-row dt{font-size:7.5px;line-height:12px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;opacity:.75}" +
  ".dcc-row dd{margin:0;font-size:10.5px;line-height:13px;text-align:right}" +
  ".dcc-row dd span{display:block}" +
  ".dcc-in{animation:dcc-in .8s cubic-bezier(.2,.7,.1,1) both;animation-delay:calc(var(--i,0) * 60ms)}" +
  "@keyframes dcc-in{from{opacity:0;transform:translateY(12px);filter:blur(5px)}}" +
  ".dcc-revs{position:absolute;bottom:calc(var(--dcc-pad) * 1.1);left:50%;transform:translateX(-50%);z-index:4;" +
  "display:flex;gap:clamp(24px,7cqw,96px);pointer-events:none}" +
  ".dcc-rev{width:clamp(130px,15cqw,200px);text-align:center}" +
  ".dcc-stars{font-size:8px;letter-spacing:3px;margin-bottom:6px}" +
  ".dcc-src{font-size:6.5px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;margin-bottom:4px}" +
  ".dcc-quote{margin:0;font-size:clamp(13px,1.35cqw,17px);line-height:1.02;text-transform:uppercase;text-wrap:balance}" +
  ".dcc-ctl{position:absolute;right:var(--dcc-pad);bottom:var(--dcc-pad);z-index:5;display:flex;align-items:center;gap:10px}" +
  ".dcc-btn{display:grid;place-items:center;width:34px;height:34px;margin:0;padding:0;border-radius:999px;" +
  "border:1px solid color-mix(in oklab,currentColor 22%,transparent);background:none;color:inherit;cursor:pointer;" +
  "transition:background .2s,opacity .2s,transform .2s}" +
  ".dcc-btn:hover:not(:disabled){background:color-mix(in oklab,currentColor 8%,transparent)}" +
  ".dcc-btn:active:not(:disabled){transform:scale(.9)}" +
  ".dcc-btn:disabled{opacity:.28;cursor:default}" +
  ".dcc-btn:focus-visible,.dcc-menubtn:focus-visible,.dcc-link:focus-visible{outline:2px solid currentColor;outline-offset:3px}" +
  ".dcc-count{font-size:11px;letter-spacing:.08em;font-variant-numeric:tabular-nums;min-width:58px;text-align:center}" +
  ".dcc-count b{font-weight:600}" +
  ".dcc-hint{position:absolute;left:var(--dcc-pad);bottom:var(--dcc-pad);z-index:4;font-size:9px;letter-spacing:.18em;" +
  "text-transform:uppercase;opacity:.45;pointer-events:none;line-height:34px}" +
  ".dcc-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}" +
  "@container (max-width:720px){.dcc-link{display:none}.dcc-rev+.dcc-rev{display:none}.dcc-hint{display:none}" +
  ".dcc-head{width:clamp(150px,44cqw,230px);top:calc(var(--dcc-pad) * 3.2)}.dcc-row:nth-child(n+3){display:none}}" +
  "@container (max-width:420px){.dcc-revs{bottom:calc(var(--dcc-pad) * 4.4)}}" +
  "@media (prefers-reduced-motion:reduce){.dcc-root .dcc-idle{animation:none}.dcc-in,.dcc-list{animation:none}" +
  ".dcc-tilt,.dcc-btn,.dcc-link,.dcc-menubtn svg{transition:none}}"

// ---- icons ---------------------------------------------------------------------------
function Arrow({ dir }: { dir: -1 | 1 }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ maxWidth: "none" }}>
      <path d={dir < 0 ? "M19 12H5m6-6-6 6 6 6" : "M5 12h14m-6-6 6 6-6 6"} />
    </svg>
  )
}

function Caret() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ maxWidth: "none" }}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

const pad = (n: number) => (n < 10 ? "0" + n : "" + n)
const lines = (v: string | string[]) => (Array.isArray(v) ? v : [v])

// ---- generated label art ---------------------------------------------------------------
function wedge(a0: number, a1: number, r: number) {
  const p = (a: number) => (100 + r * Math.cos(a)).toFixed(2) + " " + (100 + r * Math.sin(a)).toFixed(2)
  return "M100 100L" + p(a0) + "A" + r + " " + r + " 0 0 1 " + p(a1) + "Z"
}

function Art({ pattern, pal, seed, uid }: { pattern: DiscPattern; pal: [string, string, string]; seed: number; uid: string }) {
  const [bg, fg, ac] = pal
  const r = rng(seed * 9973 + 17)
  const out: React.ReactNode[] = [<rect key="bg" width="200" height="200" fill={bg} />]
  if (pattern === "sunburst") {
    const k = 28
    for (let i = 0; i < k; i += 2) out.push(<path key={"w" + i} d={wedge((i / k) * Math.PI * 2, ((i + 1) / k) * Math.PI * 2, 142)} fill={fg} />)
    out.push(<circle key="c" cx="100" cy="100" r="44" fill={ac} />)
    out.push(<circle key="c2" cx="100" cy="100" r="40.5" fill="none" stroke={bg} strokeWidth="1.6" strokeDasharray="2 3.5" />)
  } else if (pattern === "rings") {
    for (let rr = 100, i = 0; rr > 36; rr -= 7, i++)
      out.push(<circle key={"r" + i} cx="100" cy="100" r={rr} fill={i % 3 === 2 ? ac : i % 2 ? bg : fg} />)
  } else if (pattern === "halftone") {
    const fx = 50 + r() * 100
    const fy = 30 + r() * 60
    for (let y = 4; y < 200; y += 8)
      for (let x = 4 + ((y / 8) % 2) * 4; x < 200; x += 8) {
        const d = Math.hypot(x - fx, y - fy)
        const rad = Math.max(0, 3.9 - d / 34)
        if (rad > 0.3) out.push(<circle key={x + "-" + y} cx={x} cy={y} r={rad.toFixed(2)} fill={fg} />)
      }
    out.push(<circle key="s" cx={fx} cy={fy} r="16" fill={ac} />)
  } else if (pattern === "horizon") {
    out.push(
      <linearGradient key="g" id={uid + "sky"} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={bg} />
        <stop offset=".62" stopColor={ac} />
      </linearGradient>,
      <rect key="sky" width="200" height="200" fill={"url(#" + uid + "sky)"} />,
      <circle key="sun" cx={60 + r() * 80} cy="112" r="20" fill="#f6efe0" opacity=".85" />,
    )
    // a tree line: lollipop crowns and narrow cypresses on a meadow
    let x = -4
    let i = 0
    while (x < 204) {
      const h = 18 + r() * 34
      const w = 7 + r() * 9
      if (r() > 0.45) out.push(<ellipse key={"t" + i} cx={x} cy={128 - h} rx={w} ry={w * 1.1} fill={fg} />)
      else out.push(<path key={"t" + i} d={"M" + x + " " + (130 - h * 1.35) + "L" + (x + w * 0.55) + " 130L" + (x - w * 0.55) + " 130Z"} fill={fg} />)
      out.push(<rect key={"k" + i} x={x - 0.9} y={128 - h} width="1.8" height={h} fill={fg} />)
      x += w * (0.9 + r() * 0.8)
      i++
    }
    out.push(<rect key="m" y="128" width="200" height="72" fill={fg} />)
    for (let j = 0; j < 40; j++)
      out.push(<circle key={"f" + j} cx={(r() * 200).toFixed(1)} cy={(132 + r() * 66).toFixed(1)} r={(0.6 + r() * 1.2).toFixed(2)} fill={ac} opacity=".8" />)
  } else if (pattern === "stripes") {
    const g: React.ReactNode[] = []
    for (let i = -10; i < 20; i++) g.push(<rect key={"s" + i} x={i * 14} y="-60" width="7" height="320" fill={i % 4 === 0 ? ac : fg} />)
    out.push(<g key="g" transform={"rotate(" + (20 + r() * 40).toFixed(1) + " 100 100)"}>{g}</g>)
  } else if (pattern === "eclipse") {
    for (let j = 0; j < 70; j++)
      out.push(<circle key={"st" + j} cx={(r() * 200).toFixed(1)} cy={(r() * 200).toFixed(1)} r={(0.3 + r() * 0.9).toFixed(2)} fill={fg} opacity={(0.3 + r() * 0.7).toFixed(2)} />)
    out.push(
      <circle key="halo" cx="100" cy="100" r="78" fill="none" stroke={ac} strokeWidth="1" opacity=".6" />,
      <circle key="moon" cx="100" cy="100" r="66" fill={fg} />,
      <circle key="bite" cx={118} cy={88} r="62" fill={bg} />,
      <circle key="ring" cx="100" cy="100" r="66" fill="none" stroke={ac} strokeWidth="1.4" strokeDasharray="1 3" />,
    )
  } else {
    // mosaic: a tile field in the palette with a few round "windows"
    const cols = [bg, fg, ac]
    for (let y = 0; y < 200; y += 20)
      for (let x = 0; x < 200; x += 20) {
        const c = cols[Math.floor(r() * 3)]
        const kind = r()
        out.push(<rect key={"q" + x + "-" + y} x={x} y={y} width="20" height="20" fill={c} />)
        if (kind > 0.7) out.push(<circle key={"o" + x + "-" + y} cx={x + 10} cy={y + 10} r="7" fill={cols[(cols.indexOf(c) + 1) % 3]} />)
        else if (kind > 0.45) out.push(<path key={"p" + x + "-" + y} d={"M" + x + " " + y + "h20L" + x + " " + (y + 20)} fill={cols[(cols.indexOf(c) + 2) % 3]} />)
      }
  }
  return <>{out}</>
}

function Print({ item, i, uid, mark, ink, halo }: { item: DiscCascadeItem; i: number; uid: string; mark: string; ink: string; halo: string }) {
  const label = (item.label ?? item.title).toUpperCase()
  const fine =
    (item.fine ??
      (item.credits ?? [])
        .map((c) => c.label + " " + lines(c.value).join(", "))
        .join("  ·  ")).toUpperCase()
  // A halo in the label's own ground keeps the print legible over busy art, like a knocked-out plate.
  const ring = (w: number) => ({ stroke: halo, strokeWidth: item.src ? w * 0.4 : w, strokeLinejoin: "round" as const, paintOrder: "stroke" as const })
  const stroke = ring(2.4)
  const small = ring(1.2)
  let headline: React.ReactNode = null
  if (label && (item.labelStyle ?? "arc") === "arc") {
    const fs = fitSize(label.length, 226 * 0.86, 21)
    // textLength pins the set width, so a wide fallback font squeezes instead of overflowing.
    headline = (
      <text
        fill={ink}
        fontSize={fs.toFixed(2)}
        fontWeight="700"
        textAnchor="middle"
        textLength={textWidth(label.length, fs).toFixed(1)}
        lengthAdjust="spacingAndGlyphs"
        {...stroke}
      >
        <textPath href={"#" + uid + "top"} startOffset="50%">
          {label}
        </textPath>
      </text>
    )
  } else if (label) {
    // Stacked between y 26 and 58: above the hub, inside the rim.
    const ls = wrapLabel(label, 11).slice(0, 3)
    const fs = Math.min(fitSize(Math.max(...ls.map((l) => l.length)), 112, 20), 32 / (ls.length * 0.98))
    const lh = fs * 0.98
    const y0 = 58 - (ls.length - 1) * lh
    headline = (
      <g fill={ink} fontSize={fs.toFixed(2)} fontWeight="700" {...stroke}>
        {ls.map((l, k) => {
          const y = y0 + k * lh
          // the chord at this height, less a margin, bounds the line
          const room = 2 * Math.sqrt(Math.max(0, 86 * 86 - (100 - y + fs * 0.35) ** 2))
          return (
            <text
              key={k}
              x="100"
              y={y.toFixed(2)}
              textAnchor="middle"
              textLength={Math.min(textWidth(l.length, fs), room).toFixed(1)}
              lengthAdjust="spacingAndGlyphs"
            >
              {l}
            </text>
          )
        })}
      </g>
    )
  }
  return (
    <svg viewBox="0 0 200 200" aria-hidden="true" style={{ maxWidth: "none" }}>
      <defs>
        <path id={uid + "top"} d="M28 100a72 72 0 1 1 144 0" />
        <path id={uid + "bot"} d="M14 100a86 86 0 0 0 172 0" />
      </defs>
      {headline}
      {fine ? (
        <text fill={ink} fontSize="5.2" letterSpacing=".7" textAnchor="middle" opacity=".86" {...small}>
          <textPath href={"#" + uid + "bot"} startOffset="50%">
            {fine.length > 120 ? fine.slice(0, 118) + "…" : fine}
          </textPath>
        </text>
      ) : null}
      {mark ? (
        <text x="100" y="150" fill={ink} fontSize="10" fontWeight="800" letterSpacing="-.4" textAnchor="middle" {...small}>
          {mark}
        </text>
      ) : null}
      {item.src ? null : (
        <text x="100" y="64" fill={ink} fontSize="4" letterSpacing="1.2" textAnchor="middle" opacity=".6" transform="rotate(180 100 100)">
          {"DISC " + pad(i + 1)}
        </text>
      )}
    </svg>
  )
}

// The clear clamping ring, the stacking ridge and the mirror band round the hole.
function Hub({ uid }: { uid: string }) {
  return (
    <svg className="dcc-hub" viewBox="0 0 200 200" aria-hidden="true">
      <defs>
        <linearGradient id={uid + "metal"} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fbfbfc" />
          <stop offset=".45" stopColor="#a9adb3" />
          <stop offset=".55" stopColor="#eef0f2" />
          <stop offset="1" stopColor="#8f949a" />
        </linearGradient>
      </defs>
      <circle cx="100" cy="100" r="35.5" fill="none" stroke={"url(#" + uid + "metal)"} strokeWidth="4" />
      <circle cx="100" cy="100" r="25.5" fill="rgba(232,235,239,.82)" stroke="rgba(232,235,239,.82)" strokeWidth="16" />
      <circle cx="100" cy="100" r="17.6" fill="none" stroke="rgba(255,255,255,.95)" strokeWidth="1.4" />
      <circle cx="100" cy="100" r="22" fill="none" stroke="rgba(0,0,0,.12)" strokeWidth=".6" />
      <circle cx="100" cy="100" r="27" fill="none" stroke="rgba(255,255,255,.75)" strokeWidth="1.6" />
      <circle cx="100" cy="100" r="28.6" fill="none" stroke="rgba(0,0,0,.1)" strokeWidth=".6" />
      <circle cx="100" cy="100" r="33.3" fill="none" stroke="rgba(0,0,0,.16)" strokeWidth=".7" />
      <circle cx="100" cy="100" r="99.3" fill="none" stroke="rgba(255,255,255,.4)" strokeWidth="1.2" />
    </svg>
  )
}

// ---- component ----------------------------------------------------------------------
export default function DiscCascadeCarousel({
  items,
  height = "100svh",
  discSize = "clamp(170px, min(50vmin, 38vw), 420px)",
  spacing = 1.02,
  rise = 0.24,
  depth = 0.42,
  yaw = 22,
  fan = -10,
  tilt = -6,
  roll = 110,
  spin = 24,
  sheen = 0.6,
  bounce = 0.22,
  duration = 0.9,
  loop = false,
  autoplay = 0,
  brand = "",
  nav = [],
  navActive = 0,
  indexLabel = "Index",
  details = true,
  reviews = true,
  controls = true,
  hint = "Drag to browse",
  frame = true,
  color,
  background = "color-mix(in oklab, var(--color-foreground, #000) 5%, var(--color-background, #fff))",
  serif = '"Instrument Serif", "Bodoni Moda", Didot, "Times New Roman", serif',
  sans = '"Inter", ui-sans-serif, system-ui, sans-serif',
  display = '"Oswald", "Bebas Neue", Impact, "Arial Narrow", sans-serif',
  fontHref = null,
  index,
  defaultIndex = 2,
  onIndexChange,
  onSelect,
  ariaLabel = "Film catalogue",
  className = "",
}: DiscCascadeCarouselProps) {
  const n = items.length
  const start = Math.min(Math.max(Math.round(index ?? defaultIndex), 0), Math.max(n - 1, 0))
  const [active, setActive] = React.useState(start)
  const [dragging, setDragging] = React.useState(false)
  const [stopped, setStopped] = React.useState(false)
  const [focused, setFocused] = React.useState(false)
  const [visible, setVisible] = React.useState(true)
  const [menu, setMenu] = React.useState(false)

  const uid = "dcc" + React.useId().replace(/[^a-zA-Z0-9]/g, "")
  const rootRef = React.useRef(null as HTMLDivElement | null)
  const stageRef = React.useRef(null as HTMLDivElement | null)
  const menuRef = React.useRef(null as HTMLDivElement | null)
  const slideRefs = React.useRef([] as (HTMLButtonElement | null)[])

  // Everything the frame loop reads, kept off React state so a frame costs no render.
  const E = React.useRef({
    a: start, va: 0, b: start, vb: 0, target: start,
    raf: 0, last: 0, size: 300, reduced: false,
    drag: null as null | { id: number; x0: number; pos0: number; moved: boolean; samples: { t: number; x: number }[] },
    clickBlock: false, wheel: 0, wheelAt: 0, stepAt: 0,
  }).current
  const cfg = React.useRef({ n, loop, spacing, rise, depth, yaw, fan, tilt, roll, bounce, duration })
  cfg.current = { n, loop, spacing, rise, depth, yaw, fan, tilt, roll, bounce, duration }
  const cb = React.useRef({ onIndexChange, active })
  cb.current = { onIndexChange, active }

  const styleFor = (i: number, a: number, b: number) => {
    const c = cfg.current
    const p = poseOf(offsetOf(i, a, c.n, c.loop), offsetOf(i, b, c.n, c.loop), c)
    return {
      transform:
        "translate3d(calc(" + p.x.toFixed(4) + " * var(--dcc-s)), calc(" + p.y.toFixed(4) + " * var(--dcc-s)), calc(" +
        p.z.toFixed(4) + " * var(--dcc-s))) rotateZ(" + c.tilt + "deg) rotateY(" + p.yaw.toFixed(3) + "deg) rotateX(8deg)",
      roll: p.roll.toFixed(2) + "deg",
      glint: (p.yaw * 3 + p.x * 40).toFixed(1) + "deg",
      zIndex: p.zIndex,
      opacity: p.opacity,
      hidden: p.hidden || p.opacity <= 0,
    }
  }

  const paint = () => {
    for (let i = 0; i < slideRefs.current.length; i++) {
      const el = slideRefs.current[i]
      if (!el) continue
      const t = styleFor(i, E.a, E.b)
      el.style.transform = t.transform
      el.style.zIndex = "" + t.zIndex
      el.style.opacity = t.opacity < 1 ? t.opacity.toFixed(3) : ""
      el.style.visibility = t.hidden ? "hidden" : ""
      el.style.setProperty("--dcc-roll", t.roll)
      el.style.setProperty("--dcc-glint", t.glint)
    }
  }

  const frame_ = (now: number) => {
    const dt = Math.min((now - (E.last || now)) / 1000, 1 / 20)
    E.last = now
    const c = cfg.current
    const s = springOf(c.bounce, c.duration)
    if (E.reduced && !E.drag) {
      E.a = E.b = E.target
      E.va = E.vb = 0
    } else {
      // While dragging the line is under the finger and only the swing chases it.
      if (!E.drag) [E.a, E.va] = springStep(E.a, E.va, E.target, s.omega, s.slide, dt)
      ;[E.b, E.vb] = springStep(E.b, E.vb, E.a, s.omega * 1.05, s.tilt, dt)
    }
    paint()
    const settled =
      !E.drag && Math.abs(E.a - E.target) < 1e-3 && Math.abs(E.va) < 1e-2 && Math.abs(E.b - E.a) < 1e-3 && Math.abs(E.vb) < 1e-2
    if (settled) {
      E.a = E.b = E.target
      E.va = E.vb = 0
      paint()
      E.raf = 0
      E.last = 0
      return
    }
    E.raf = requestAnimationFrame(frame_)
  }

  const kick = () => {
    if (!E.raf) E.raf = requestAnimationFrame(frame_)
  }

  const setTarget = (t: number) => {
    const c = cfg.current
    if (!c.n) return
    E.target = c.loop ? t : Math.min(Math.max(t, 0), c.n - 1)
    const i = indexAt(E.target, c.n, c.loop)
    if (i !== cb.current.active) {
      setActive(i)
      cb.current.onIndexChange?.(i)
    }
    kick()
  }

  const goTo = (i: number) => setTarget(targetFor(i, E.target, cfg.current.n, cfg.current.loop))
  const step = (by: number) => setTarget(Math.round(E.target) + by)

  // controlled index
  React.useEffect(() => {
    if (index == null || !n) return
    if (wrapIndex(Math.round(E.target), n) !== wrapIndex(index, n)) goTo(wrapIndex(index, n))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, n])

  // a shorter list mustn't leave the position past its end
  React.useEffect(() => {
    if (n && !loop && E.target > n - 1) setTarget(n - 1)
    paint()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, loop, spacing, rise, depth, yaw, fan, tilt, roll])

  // reduced motion
  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
    const on = () => {
      E.reduced = mq.matches
    }
    on()
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [E])

  // the disc size in px, for turning drag distance into slides
  React.useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = () => {
      E.size = el.offsetWidth || 300
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [E])

  React.useEffect(() => () => cancelAnimationFrame(E.raf), [E])

  // fonts arrive by <link>, and only when asked for
  React.useEffect(() => {
    if (!fontHref) return
    const exists = Array.from(document.querySelectorAll("link[rel=stylesheet]")).some(
      (l) => (l as HTMLLinkElement).href === fontHref,
    )
    if (exists) return
    const link = document.createElement("link")
    link.rel = "stylesheet"
    link.href = fontHref
    link.setAttribute("data-disc-cascade-font", "")
    document.head.appendChild(link)
  }, [fontHref])

  // Horizontal trackpad swipes step through; vertical wheel is left to the page.
  React.useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
      e.preventDefault()
      const now = performance.now()
      if (now - E.wheelAt > 160) E.wheel = 0
      E.wheelAt = now
      E.wheel += e.deltaX
      if (Math.abs(E.wheel) > 50 && now - E.stepAt > 320) {
        setStopped(true)
        step(Math.sign(E.wheel))
        E.wheel = 0
        E.stepAt = now
      }
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [E])

  // the Index menu closes on an outside press or Escape
  React.useEffect(() => {
    if (!menu) return
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false)
    }
    document.addEventListener("pointerdown", onDown)
    return () => document.removeEventListener("pointerdown", onDown)
  }, [menu])

  // autoplay pauses off-screen and in a hidden tab
  React.useEffect(() => {
    const el = rootRef.current
    if (!el || !autoplay) return
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting && !document.hidden))
    io.observe(el)
    const onVis = () => setVisible(!document.hidden)
    document.addEventListener("visibilitychange", onVis)
    return () => {
      io.disconnect()
      document.removeEventListener("visibilitychange", onVis)
    }
  }, [autoplay])

  const playing = autoplay > 0 && n > 1 && !stopped && !focused && !dragging && !menu && visible
  React.useEffect(() => {
    if (!playing || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const t = window.setTimeout(() => {
      const c = cfg.current
      if (!c.loop && Math.round(E.target) >= c.n - 1) goTo(0)
      else step(1)
    }, autoplay)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, active, autoplay])

  // ---- pointer ------------------------------------------------------------------------
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !n) return
    if ((e.target as Element).closest("[data-dcc-ui]")) return
    E.drag = { id: e.pointerId, x0: e.clientX, pos0: E.a, moved: false, samples: [{ t: e.timeStamp, x: e.clientX }] }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    // The glint and the chosen disc's lean follow a mouse, never a finger.
    if (e.pointerType === "mouse" && !E.drag?.moved) {
      const st = stageRef.current?.getBoundingClientRect()
      const root = rootRef.current
      if (st && root) {
        const cx = Math.max(-1, Math.min(1, (e.clientX - (st.left + st.width / 2)) / st.width))
        const cy = Math.max(-1, Math.min(1, (e.clientY - (st.top + st.height / 2)) / st.height))
        root.style.setProperty("--dcc-px", cx.toFixed(3))
        root.style.setProperty("--dcc-py", cy.toFixed(3))
      }
    }
    const d = E.drag
    if (!d || d.id !== e.pointerId) return
    const dx = e.clientX - d.x0
    if (!d.moved) {
      if (Math.abs(dx) < 6) return
      d.moved = true
      d.x0 = e.clientX
      d.pos0 = E.a
      E.va = 0
      rootRef.current?.setPointerCapture(e.pointerId)
      setDragging(true)
      setStopped(true)
    }
    const c = cfg.current
    const raw = d.pos0 - (e.clientX - d.x0) / (E.size * c.spacing)
    E.a = c.loop ? raw : rubber(raw, c.n)
    d.samples.push({ t: e.timeStamp, x: e.clientX })
    if (d.samples.length > 6) d.samples.shift()
    const i = indexAt(E.a, c.n, c.loop)
    if (i !== cb.current.active) {
      setActive(i)
      cb.current.onIndexChange?.(i)
    }
    kick()
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const d = E.drag
    if (!d || d.id !== e.pointerId) return
    E.drag = null
    if (!d.moved) return
    setDragging(false)
    E.clickBlock = true
    window.setTimeout(() => {
      E.clickBlock = false
    }, 0)
    const first = d.samples[0]
    const last = d.samples[d.samples.length - 1]
    const ms = Math.max(last.t - first.t, 1)
    // px per ms → slides per second, against the drag direction
    const v = e.type === "pointercancel" ? 0 : (-(last.x - first.x) / ms / (E.size * cfg.current.spacing)) * 1000
    E.va = v
    setTarget(releaseTarget(E.a, v, cfg.current.n, cfg.current.loop))
  }
  const onPointerLeave = () => {
    rootRef.current?.style.setProperty("--dcc-px", "0")
    rootRef.current?.style.setProperty("--dcc-py", "0")
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && menu) {
      setMenu(false)
      return
    }
    if ((e.target as Element).closest("[data-dcc-menu]")) return
    let handled = true
    if (e.key === "ArrowRight" || e.key === "ArrowDown") step(1)
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") step(-1)
    else if (e.key === "Home") goTo(0)
    else if (e.key === "End") goTo(n - 1)
    else handled = false
    if (handled) {
      e.preventDefault()
      setStopped(true)
    }
  }

  const onSlideClick = (i: number) => {
    if (E.clickBlock) return
    setStopped(true)
    if (i === active) onSelect?.(items[i], i)
    else goTo(i)
  }

  const atStart = !loop && active <= 0
  const atEnd = !loop && active >= n - 1
  const current = items[active]
  const quotes = (current?.reviews ?? []).slice(0, 2)
  const year = current?.credits?.find((c) => /year/i.test(c.label))

  return (
    <div
      ref={rootRef}
      className={"dcc-root " + className}
      style={
        {
          height,
          background,
          color,
          fontFamily: sans,
          ["--dcc-s" as string]: discSize,
          ["--dcc-sheen" as string]: "" + sheen,
          ["--dcc-spin" as string]: spin + "s",
        } as React.CSSProperties
      }
      role="region"
      aria-roledescription="carousel"
      aria-label={ariaLabel}
      tabIndex={0}
      data-dragging={dragging ? "" : undefined}
      data-spin={spin > 0 ? "" : undefined}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerLeave}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false)
      }}
    >
      <style>{CSS}</style>
      {frame ? <div className="dcc-frame" aria-hidden="true" /> : null}

      {brand || nav.length || (indexLabel && n > 1) ? (
        <nav className="dcc-nav" data-dcc-ui="" aria-label="Catalogue">
          {brand ? <span className="dcc-brand">{brand}</span> : null}
          {nav.map((l, k) =>
            l.href ? (
              <a key={k} className="dcc-link" href={l.href} aria-current={k === navActive ? "page" : undefined}>
                {l.label}
              </a>
            ) : (
              <span key={k} className="dcc-link" aria-current={k === navActive ? "true" : undefined}>
                {l.label}
              </span>
            ),
          )}
          {indexLabel && n > 1 ? (
            <div className="dcc-menu" ref={menuRef} data-dcc-menu="">
              <button
                type="button"
                className="dcc-menubtn"
                aria-haspopup="true"
                aria-expanded={menu}
                aria-controls={uid + "list"}
                onClick={() => setMenu((m) => !m)}
              >
                {indexLabel} <Caret />
              </button>
              {menu ? (
                <ul className="dcc-list" id={uid + "list"} style={{ fontFamily: sans }}>
                  {items.map((it, k) => {
                    const y = it.credits?.find((c) => /year/i.test(c.label))
                    return (
                      <li key={k}>
                        <button
                          type="button"
                          className="dcc-opt"
                          aria-current={k === active ? "true" : undefined}
                          onClick={() => {
                            setStopped(true)
                            setMenu(false)
                            goTo(k)
                          }}
                        >
                          <span className="dcc-optn">{pad(k + 1)}</span>
                          <span className="dcc-optt">{it.title}</span>
                          {y ? <span className="dcc-opty">{lines(y.value)[0]}</span> : null}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              ) : null}
            </div>
          ) : null}
        </nav>
      ) : null}

      {details && current ? (
        <div className="dcc-head" key={"h" + active} aria-hidden="true">
          <h2 className="dcc-title dcc-in" style={{ fontFamily: serif }}>
            {current.title}
          </h2>
          {current.credits?.length ? (
            <dl className="dcc-dl">
              {current.credits.map((c, k) => (
                <div className="dcc-row dcc-in" key={k} style={{ ["--i" as string]: k + 1 } as React.CSSProperties}>
                  <dt>{c.label}</dt>
                  <dd>
                    {lines(c.value).map((v, j) => (
                      <span key={j}>{v}</span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      ) : null}

      <div ref={stageRef} className="dcc-stage">
        {items.map((item, i) => {
          const t = styleFor(i, E.a, E.b)
          const isActive = i === active
          const pal = item.palette ?? PALETTES[i % PALETTES.length]
          const ink = item.ink ?? (item.src ? "#ffffff" : inkFor(pal[0]))
          const id = uid + "d" + i
          return (
            <button
              key={i}
              ref={(el) => {
                slideRefs.current[i] = el
              }}
              type="button"
              className="dcc-slide"
              data-active={isActive ? "" : undefined}
              tabIndex={isActive ? 0 : -1}
              aria-roledescription="slide"
              aria-label={i + 1 + " of " + n + ": " + item.title}
              aria-current={isActive ? "true" : undefined}
              onClick={() => onSlideClick(i)}
              style={
                {
                  transform: t.transform,
                  zIndex: t.zIndex,
                  opacity: t.opacity < 1 ? t.opacity : undefined,
                  visibility: t.hidden ? "hidden" : undefined,
                  ["--dcc-roll" as string]: t.roll,
                  ["--dcc-glint" as string]: t.glint,
                } as React.CSSProperties
              }
            >
              <span className="dcc-tilt">
                <span className="dcc-shade" />
                <span className="dcc-edge" />
                <span className="dcc-disc">
                  <span className="dcc-roll">
                    <span className="dcc-idle" style={{ fontFamily: display }}>
                      {item.src ? (
                        <img
                          src={item.src}
                          alt={item.alt ?? item.title}
                          draggable={false}
                          loading={Math.abs(i - start) > 3 ? "lazy" : undefined}
                          decoding="async"
                          width={600}
                          height={600}
                          style={{ maxWidth: "none" }}
                        />
                      ) : (
                        <svg viewBox="0 0 200 200" role="img" aria-label={item.alt ?? item.title} style={{ maxWidth: "none" }}>
                          <Art pattern={item.pattern ?? PATTERNS[i % PATTERNS.length]} pal={pal} seed={i + 1} uid={id} />
                        </svg>
                      )}
                      <Print item={item} i={i} uid={id} mark={brand} ink={ink} halo={item.src ? "rgba(0,0,0,.45)" : pal[0]} />
                    </span>
                  </span>
                  <Hub uid={id} />
                  <span className="dcc-sheen" />
                </span>
              </span>
            </button>
          )
        })}
      </div>

      {reviews && quotes.length ? (
        <div className="dcc-revs" key={"r" + active} aria-hidden="true">
          {quotes.map((q, k) => {
            const stars = Math.max(0, Math.min(5, Math.round(q.stars ?? 5)))
            return (
              <figure className="dcc-rev dcc-in" key={k} style={{ margin: 0, ["--i" as string]: k + 3 } as React.CSSProperties}>
                <div className="dcc-stars">{"★".repeat(stars) + "☆".repeat(5 - stars)}</div>
                <figcaption className="dcc-src">{q.source}</figcaption>
                <blockquote className="dcc-quote" style={{ fontFamily: serif }}>
                  {"“" + q.quote + "”"}
                </blockquote>
              </figure>
            )
          })}
        </div>
      ) : null}

      {hint ? <div className="dcc-hint" aria-hidden="true">{hint}</div> : null}

      {controls && n > 1 ? (
        <div className="dcc-ctl" data-dcc-ui="">
          <button type="button" className="dcc-btn" aria-label="Previous film" disabled={atStart} onClick={() => { setStopped(true); step(-1) }}>
            <Arrow dir={-1} />
          </button>
          <span className="dcc-count" aria-hidden="true">
            <b>{pad(active + 1)}</b> / {pad(n)}
          </span>
          <button type="button" className="dcc-btn" aria-label="Next film" disabled={atEnd} onClick={() => { setStopped(true); step(1) }}>
            <Arrow dir={1} />
          </button>
        </div>
      ) : null}

      <div className="dcc-sr" aria-live="polite" aria-atomic="true">
        {current
          ? "Film " + (active + 1) + " of " + n + ": " + current.title + (year ? ", " + lines(year.value)[0] : "")
          : ""}
      </div>
    </div>
  )
}
