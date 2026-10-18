// 3D stage for Dashavani Studio. Home: a curved strip of images (template previews, stills from finished
// videos, and a poster for each language edition) that scrolls on its own and with the page.
// Job: the master sheet moving across five press stations.
import * as THREE from "three";
import { t } from "./i18n.js";

const GROUND = "#0a0a0b", DEEP = "#050506", ACCENT = "#ff5a47", SURFACE = "#f4f4f5", ERROR = "#ff6b57";
// [the word "news", language, live today?]
const EDITIONS = [
  ["News", t("English"), true], ["వార్తలు", t("Telugu"), true], ["समाचार", t("Hindi")], ["செய்திகள்", t("Tamil")], ["ಸುದ್ದಿ", t("Kannada")],
  ["വാർത്ത", t("Malayalam")], ["बातम्या", t("Marathi")], ["সংবাদ", t("Bengali")], ["સમાચાર", t("Gujarati")], ["ସମ୍ବାଦ", t("Odia")],
];
const STATIONS = [[t("Script"), ["script", "script_review"]], [t("Voice"), ["voice", "voice_review", "compose"]], [t("Draft"), ["draft", "draft_review"]], [t("Presenter"), ["avatar"]], [t("Final"), ["final", "done"]]];
// Anek covers Latin and Telugu here; the other scripts fall back to the OS's own fonts.
const FONT = '"Anek Latin", "Noto Sans Telugu", "Noto Sans Devanagari", "Noto Sans Tamil", "Noto Sans Kannada", "Noto Sans Malayalam", "Noto Sans Bengali", "Noto Sans Gujarati", "Noto Sans Oriya", system-ui, sans-serif';
// ?still also snaps to the final pose (handy for screenshots and slow machines).
const still = matchMedia("(prefers-reduced-motion: reduce)").matches || new URLSearchParams(location.search).has("still");

const canvasTexture = (c) => Object.assign(new THREE.CanvasTexture(c), { colorSpace: THREE.SRGBColorSpace, anisotropy: 8 });

// A portrait poster for one language edition: live editions in red, the rest alternate dark and light.
function posterTexture([word, name, live], i) {
  const c = Object.assign(document.createElement("canvas"), { width: 600, height: 800 });
  const g = c.getContext("2d");
  const bg = live ? "#d8341f" : ["#141416", "#f4f4f5", "#1c1c1f"][i % 3];
  const ink = bg === "#f4f4f5" ? GROUND : SURFACE;
  g.fillStyle = bg; g.fillRect(0, 0, 600, 800);
  g.fillStyle = ink; g.textBaseline = "alphabetic";
  let size = 150;
  do g.font = `700 ${size}px ${FONT}`; while (g.measureText(word).width > 520 && (size -= 8) > 40);
  g.fillText(word, 40, 470);
  g.font = `500 36px ${FONT}`; g.globalAlpha = 0.75; g.fillText(t("{lang} edition", { lang: name }), 40, 740); g.globalAlpha = 1;
  g.font = `700 30px ${FONT}`; g.fillText(live ? t("● Live") : t("Coming next"), 40, 80);
  return canvasTexture(c);
}

// Redraws an image (or canvas) with rounded corners, so strip cards read like photo prints.
function rounded(src, radius = 0.045) {
  const w = src.width, h = src.height, r = Math.min(w, h) * radius;
  const c = Object.assign(document.createElement("canvas"), { width: w, height: h });
  const g = c.getContext("2d");
  g.beginPath(); g.roundRect(0, 0, w, h, r); g.clip();
  g.drawImage(src, 0, 0, w, h);
  return canvasTexture(c);
}

function sheetTexture(draw, w = 768, h = 1024) {
  const c = Object.assign(document.createElement("canvas"), { width: w, height: h });
  const g = c.getContext("2d");
  g.fillStyle = SURFACE; g.fillRect(0, 0, w, h);
  g.fillStyle = GROUND; g.textBaseline = "alphabetic";
  g.font = `800 88px ${FONT}`; g.fillText("DASHA", 56, 136);
  const x = 56 + g.measureText("DASHA").width + 22;
  g.fillStyle = ACCENT; g.fillRect(x, 70, 12, 74);
  g.fillStyle = GROUND; g.font = `500 48px ${FONT}`; g.fillText("VANI", x + 30, 132);
  draw(g, w, h);
  return canvasTexture(c);
}

function wrap(g, text, maxW) {
  const lines = []; let line = "";
  for (const word of String(text).split(/\s+/)) {
    const test = line ? `${line} ${word}` : word;
    if (g.measureText(test).width > maxW && line) { lines.push(line); line = word; } else line = test;
  }
  return line ? [...lines, line] : lines;
}

function sheet(texture, w, h) {
  const edge = new THREE.MeshStandardMaterial({ color: "#d4d4d8", roughness: 0.8 });
  const face = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.7 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.03), [edge, edge, edge, edge, face, face]);
  mesh.castShadow = true;
  return mesh;
}

function label(text) {
  const c = Object.assign(document.createElement("canvas"), { width: 512, height: 96 });
  const g = c.getContext("2d");
  g.fillStyle = SURFACE; g.font = `600 52px ${FONT}`; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(text, 256, 50);
  return new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.34), new THREE.MeshBasicMaterial({ map: canvasTexture(c), transparent: true }));
}

export async function mountPress(canvas) {
  await Promise.all([document.fonts.load(`700 40px "Anek Latin"`), document.fonts.load(`700 40px "Noto Sans Telugu"`)]).catch(() => {});

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();
  // Transparent: the page behind the canvas supplies the backdrop and glow.
  scene.fog = new THREE.Fog("#0a0a0b", 9, 24);
  const camera = new THREE.PerspectiveCamera(32, 2, 0.1, 100);
  camera.position.set(0, 0.6, 15);

  scene.add(new THREE.HemisphereLight("#ffffff", DEEP, 1.4));
  const key = new THREE.DirectionalLight("#fff4dc", 2.4);
  key.position.set(-5, 9, 7); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -12, right: 12, top: 10, bottom: -6 });
  scene.add(key);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: "#111113", roughness: 1 }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -2.2; floor.receiveShadow = true;
  scene.add(floor);

  // Home: the image strip. Cards are arcs of one cylinder, so the strip bows toward you like a reel.
  const strip = new THREE.Group();
  scene.add(strip);
  const loader = new THREE.TextureLoader();
  let stripSig = "";
  async function buildStrip(urls) {
    const sig = urls.join("|");
    if (sig === stripSig) return;
    stripSig = sig;
    const images = (await Promise.all(urls.map((u) => loader.loadAsync(u).catch(() => null)))).filter(Boolean).map((t) => { const r = rounded(t.image); t.dispose(); return r; });
    if (sig !== stripSig) { images.forEach((t) => t.dispose()); return; } // a newer strip was asked for while these loaded
    const posters = EDITIONS.map((e, i) => rounded(posterTexture(e, i).image));
    const set = [];
    for (let i = 0; i < Math.max(images.length, posters.length); i++) {
      if (images[i]) set.push(images[i]);
      if (posters[i]) set.push(posters[i]);
    }
    // Repeat the set so the reel is wide enough to span the screen with plenty of cards in view.
    let cards = [...set];
    while (cards.length < 30) cards = cards.concat(set);
    const used = new Set(strip.children.map((m) => m.material.map));
    strip.children.forEach((m) => { m.geometry.dispose(); m.material.dispose(); });
    used.forEach((t) => t?.dispose());
    strip.clear();
    const H = 2.4, GAP = 0.18;
    const widths = cards.map((t) => Math.min(4.3, Math.max(1.5, (H * t.image.width) / t.image.height)));
    const R = widths.reduce((a, w) => a + w + GAP, 0) / (2 * Math.PI);
    let a = 0;
    cards.forEach((map, i) => {
      const len = widths[i] / R;
      const geo = new THREE.CylinderGeometry(R, R, H, Math.max(8, Math.ceil(len * 48)), 1, true, a, len);
      const card = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map, transparent: true }));
      card.position.y = Math.sin(i * 1.3) * 0.16; // a gentle wave, like a strip of film
      strip.add(card);
      a += len + GAP / R;
    });
    strip.userData.R = R;
  }

  // Job: five press stations and one master sheet
  const press = new THREE.Group();
  const plates = STATIONS.map(([name], i) => {
    const plate = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.18, 1.4), new THREE.MeshStandardMaterial({ color: "#232327", roughness: 0.6, metalness: 0.2, emissive: ACCENT, emissiveIntensity: 0 }));
    plate.position.set((i - 2) * 2.7, -2.1, 0); plate.receiveShadow = true; plate.castShadow = true;
    const tag = label(name); tag.rotation.x = -Math.PI / 2; tag.position.set(plate.position.x, -2.0, 0.95);
    press.add(plate, tag);
    return plate;
  });
  const track = new THREE.Mesh(new THREE.BoxGeometry(13.2, 0.04, 0.12), new THREE.MeshStandardMaterial({ color: ACCENT, roughness: 0.4 }));
  track.position.set(0, -2.12, -0.9); press.add(track);
  let master = null;
  scene.add(press);

  const state = { mode: "home", station: 0, error: false, done: false, scroll: 0 };
  const target = new THREE.Vector3(), lookAt = new THREE.Vector3();
  const pointer = { x: 0, y: 0 };
  canvas.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect();
    pointer.x = (e.clientX - r.left) / r.width - 0.5; pointer.y = (e.clientY - r.top) / r.height - 0.5;
  });

  // Narrow screens pull the camera back so several cards stay in view; the edge fade moves with it.
  let reach = 1;
  const resize = () => {
    const { clientWidth: w, clientHeight: h } = canvas;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    reach = Math.max(1, 1.9 / camera.aspect);
    scene.fog.near = 9 * reach; scene.fog.far = 24 * reach;
  };
  new ResizeObserver(resize).observe(canvas); resize();

  let last = performance.now();
  renderer.setAnimationLoop(() => {
    // Time-based easing: same speed at any frame rate (throttled tabs, 120 Hz screens).
    const now = performance.now(), dt = Math.min((now - last) / 1000, 1), t = now / 1000; last = now;
    const k = still ? 1 : 1 - Math.exp(-dt * 3.5);
    const home = state.mode === "home";

    strip.visible = home;
    press.visible = floor.visible = !home;
    // Drifts on its own; page scroll pushes it along; the mouse tilts it slightly.
    if (!still) strip.userData.spin = (strip.userData.spin ?? 0) + dt * 0.045;
    strip.rotation.set(pointer.y * 0.08, -((strip.userData.spin ?? 0) + state.scroll * 1.4), pointer.x * 0.04);

    const R = strip.userData.R ?? 6;
    if (home) { target.set(0, 0.4, R + 8.5 * reach); lookAt.set(0, 0, 0); }
    else { target.set(0, 0.6, 13); lookAt.set(0, -1.6, 0); }
    camera.position.lerp(target.clone().add(new THREE.Vector3(home ? 0 : pointer.x * 1.6, home ? 0 : -pointer.y * 0.8, 0)), k);
    camera.lookAt(lookAt);

    // surface = done, accent (pulsing) = now, ground = still to come, error = stopped
    plates.forEach((p, i) => {
      const cur = !state.done && i === state.station;
      const want = cur ? (state.error ? ERROR : ACCENT) : state.done || i < state.station ? "#d4d4d8" : "#232327";
      p.material.color.lerp(new THREE.Color(want), k);
      p.material.emissive.set(want);
      p.material.emissiveIntensity = cur && !still ? 0.15 + Math.sin(t * 3) * 0.12 : 0;
    });
    if (master) {
      const x = (state.station - 2) * 2.7;
      master.position.lerp(new THREE.Vector3(x, (state.done ? -0.25 : -0.45) + (still ? 0 : Math.sin(t * 1.6) * 0.05), 0.1), k);
      const tilt = state.done ? 0 : -0.35;
      master.rotation.x += (tilt - master.rotation.x) * k;
      master.rotation.y = state.done && !still ? Math.sin(t * 0.8) * 0.15 : 0;
    }
    renderer.render(scene, camera);
  });

  return {
    showHome() { state.mode = "home"; },
    /** Images for the home strip; edition posters are mixed in between them. */
    setImages(urls) { buildStrip(urls); },
    setScroll(p) { state.scroll = Math.min(1, Math.max(0, p)); },
    showJob({ headline, category, status, lang }) {
      state.mode = "job";
      state.error = status === "error";
      state.done = status === "done";
      const found = STATIONS.findIndex(([, keys]) => keys.includes(status));
      if (found >= 0) state.station = found;
      const sig = `${headline}|${category}|${lang}`;
      if (master?.userData.sig === sig) return;
      if (master) { // each story's sheet is a 768x1024 texture; the box has one material per face, edges shared
        press.remove(master); master.geometry.dispose();
        for (const m of new Set([].concat(master.material))) { m.map?.dispose(); m.dispose(); }
      }
      const tex = sheetTexture((g, w) => {
        g.fillStyle = ACCENT; g.fillRect(56, 230, Math.min(w - 112, 40 + g.measureText(String(category || t("Story"))).width * 1.6), 58);
        g.fillStyle = GROUND; g.font = `700 34px ${FONT}`; g.fillText(String(category || t("Story")).slice(0, 16), 76, 271);
        g.font = `700 70px ${FONT}`;
        wrap(g, headline || t("Writing the script…"), w - 112).slice(0, 7).forEach((l, i) => g.fillText(l, 56, 400 + i * 84));
      });
      master = sheet(tex, 2.25, 3);
      master.userData.sig = sig;
      master.position.set((state.station - 2) * 2.7, 3, 0);
      press.add(master);
    },
  };
}
