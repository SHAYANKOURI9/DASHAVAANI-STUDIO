import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// The Vercel showcase is a plain static page: every file it points to must be inside showcase/, and it never calls the
// studio's server (/api, /media of a story), which doesn't exist on Vercel.
test("the showcase page only uses its own files", () => {
  const html = fs.readFileSync("showcase/index.html", "utf8");
  const local = [...html.matchAll(/(?:src|href|poster|content)="(\/[^"#?]*)"/g)].map((m) => m[1]).filter((p) => p !== "/");
  assert.ok(local.length >= 15, `found ${local.length} files`);
  for (const p of local) assert.ok(fs.existsSync(path.join("showcase", p)), `missing: showcase${p}`);
  assert.doesNotMatch(html, /\/api\//);
  assert.ok(fs.readdirSync("showcase/media").reduce((n, f) => n + fs.statSync(`showcase/media/${f}`).size, 0) < 6e6, "media stays small");
  JSON.parse(fs.readFileSync("showcase/vercel.json", "utf8"));
});
