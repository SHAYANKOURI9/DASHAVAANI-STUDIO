// Shows "Open the live studio" only once its address is set in config.js.
const link = document.getElementById("studio-link");
if (window.STUDIO_URL) { link.href = window.STUDIO_URL; link.hidden = false; }
// One video plays at a time.
for (const v of document.querySelectorAll("video")) v.addEventListener("play", () => document.querySelectorAll("video").forEach((o) => o !== v && o.pause()));
