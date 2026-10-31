// Renders the three PDFs the tracker builds in the browser (application hand-off, market check,
// national check) from fixed sample data, so their layout can be checked without signing in or
// running a market check. Node stands in for the browser: `window`, `fetch` for web/assets and
// jsPDF (the same version index.html pins, as a devDependency) are provided here and the real
// web/pdf-kit.js, web/application-pdf.js and web/market-report.js are loaded unchanged.
//
//   npm run pdf:samples            writes scripts/pdf-samples/out/*.pdf (gitignored)
//
// The sample data is invented (names, employers, figures) and stands for the shapes the real
// rows have: see the model comments in web/application-pdf.js and the column comments in the
// market_checks and national_checks migrations.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { jsPDF } from "jspdf";
import { application, marketCheck, nationalCheck, position } from "./fixtures.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, "../../web");
const out = path.join(here, "out");

globalThis.window = globalThis;
globalThis.jspdf = { jsPDF };
// web/pdf-kit.js fetches "assets/..." relative to the page; serve those from web/.
globalThis.fetch = async (p) => {
  try {
    const buf = await readFile(path.join(web, String(p)));
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  } catch (e) { return { ok: false, status: 404, arrayBuffer: async () => { throw e; } }; }
};

await import(path.join(web, "pdf-kit.js"));
await import(path.join(web, "application-pdf.js"));
await import(path.join(web, "market-report.js"));
const RR = globalThis.RR;

const only = process.argv[2];                     // optional: application | market | national
await mkdir(out, { recursive: true });
async function save(name, pdf) {
  const buf = Buffer.from(pdf.output("arraybuffer"));
  await writeFile(path.join(out, name), buf);
  console.log(`${name}: ${pdf.getNumberOfPages()} page(s), ${(buf.length / 1024).toFixed(0)} KB`);
}
if (!only || only === "application") save(RR.applicationPdf.fileName(application.name), await RR.applicationPdf.build(application));
if (!only || only === "market") save(RR.marketReport.fileName(position, marketCheck), await RR.marketReport.build(position, marketCheck, "Andy Meyer"));
if (!only || only === "national") save(RR.marketReport.nationalFileName(position, nationalCheck), await RR.marketReport.buildNational(position, nationalCheck, "Andy Meyer"));
