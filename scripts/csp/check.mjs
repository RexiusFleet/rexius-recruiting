// Checks the hashes web/index.html depends on (npm run csp:check):
//   * the Content-Security-Policy names the Word-preview frame's inline script by SHA-256
//     (FRAME_SCRIPT in web/file-viewer.js; a srcdoc frame answers to the page's policy too);
//   * the two CDN script tags carry the SHA-384 of the same files in node_modules, so the
//     browser refuses a CDN copy that differs from the published package.
// Exits 1 and prints the right value when one is out of date. No network.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = readFileSync(join(root, "web/index.html"), "utf8");
const viewer = readFileSync(join(root, "web/file-viewer.js"), "utf8");
let bad = 0;
function expect(what, value) {
  if (html.includes(value)) { console.log(`ok   ${what}`); return; }
  bad++; console.log(`FAIL ${what}: index.html should contain\n     ${value}`);
}

const m = viewer.match(/var FRAME_SCRIPT =\s*((?:\s*'(?:[^'\\]|\\.)*'\s*\+?)+);/);
if (!m) { console.log("FAIL could not find FRAME_SCRIPT in web/file-viewer.js"); process.exit(1); }
const frameScript = [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1].replace(/\\(.)/g, "$1")).join("");
expect("Word-preview frame script hash", `'sha256-${createHash("sha256").update(frameScript, "utf8").digest("base64")}'`);

const libs = [
  ["@supabase/supabase-js", "dist/umd/supabase.js"],
  ["jspdf", "dist/jspdf.umd.min.js"],
];
for (const [pkg, file] of libs) {
  const version = JSON.parse(readFileSync(join(root, "node_modules", pkg, "package.json"), "utf8")).version;
  const sri = "sha384-" + createHash("sha384").update(readFileSync(join(root, "node_modules", pkg, file))).digest("base64");
  expect(`${pkg}@${version} script tag`, `src="https://cdn.jsdelivr.net/npm/${pkg}@${version}/${file}" integrity="${sri}" crossorigin="anonymous"`);
}
process.exit(bad ? 1 : 0);
