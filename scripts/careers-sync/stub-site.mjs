// A stand-in for rexius.com's careers blog, for testing recruiting-careers-sync on the local
// stack without touching the real site. Serves the Atom feed, the three location-tag feeds and
// the job pages from a list of jobs held in memory, which a test changes with POST /__state.
//
//   npm run careers:stub                      (listens on 8789)
//   CAREERS_BASE=http://host.docker.internal:8789 in supabase/functions/.env, then
//   npx supabase functions serve --env-file supabase/functions/.env
//
//   curl -X POST localhost:8789/__state -d '{"jobs":[{"handle":"crew1","title":"Crew Member","tags":["eugene"],"pay":"$20-$24/hr"}]}'
//   curl -X POST localhost:8789/__state -d '{"mode":"down"}'      503 on everything
//   curl -X POST localhost:8789/__state -d '{"mode":"blocked"}'   200 with an HTML page instead of a feed
//   Each job: handle, title, tags (eugene, central-oregon, lake-oswego), pay (the text after
//   "Pay:"; omit for a page with no pay line), published (ISO), hidden (true: left out of the
//   feeds but the page still answers 200).

import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 8789);
let state = {
  mode: "ok",
  jobs: [
    { handle: "landscape-maintenance-crew-member14", title: "Landscape Maintenance Crew Member", tags: ["central-oregon"], pay: "$20.00 - $23.00/hour D.O.E." },
    { handle: "truck-driver8", title: "Flatbed Truck Driver - Home Most Nights", tags: ["eugene"], pay: "Up to $82,000 annually. $1,200+ a week." },
    { handle: "all-positions", title: "General Application", tags: ["eugene", "central-oregon", "lake-oswego"] },
  ],
};
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const url = (j) => `https://rexius.com/blogs/careers/${j.handle}`;
const entry = (j) => `
  <entry>
    <id>${url(j)}</id>
    <published>${j.published || "2026-02-20T07:06:45-08:00"}</published>
    <updated>${j.updated || j.published || "2026-09-30T09:45:31-07:00"}</updated>
    <link rel="alternate" type="text/html" href="${url(j)}"/>
    <title>${esc(j.title)}</title>
    <author><name>Stub</name></author>
    <content type="html"><![CDATA[<p><strong>Job Type: </strong>Full-time</p>${j.pay ? `<p><strong>Pay:  </strong>${esc(j.pay)}</p>` : ""}<p><strong>Description:</strong></p><p>Stub job page.</p>]]></content>
  </entry>`;
const feed = (jobs) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xml:lang="en-US" xmlns="http://www.w3.org/2005/Atom">
  <id>https://rexius.com/blogs/careers.atom</id>
  <title>Rexius - Careers (stub)</title>${jobs.filter((j) => !j.hidden).map(entry).join("")}
</feed>`;

createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  const send = (status, type, body) => { res.writeHead(status, { "content-type": type }); res.end(body); console.log(`${req.method} ${path} -> ${status}`); };
  if (req.method === "POST" && path === "/__state") {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => { try { state = { ...state, ...JSON.parse(raw || "{}") }; send(200, "application/json", JSON.stringify({ mode: state.mode, jobs: state.jobs.length })); } catch { send(400, "application/json", '{"error":"bad JSON"}'); } });
    return;
  }
  if (state.mode === "down") return send(503, "text/plain", "Service Unavailable");
  if (state.mode === "blocked") return send(200, "text/html", "<html><body>Just a moment...</body></html>");
  if (path === "/blogs/careers.atom") return send(200, "application/atom+xml; charset=utf-8", feed(state.jobs));
  const tag = /^\/blogs\/careers\/tagged\/([a-z0-9-]+)\.atom$/.exec(path);
  if (tag) return send(200, "application/atom+xml; charset=utf-8", feed(state.jobs.filter((j) => (j.tags || []).includes(tag[1]))));
  const page = /^\/blogs\/careers\/([a-z0-9-]+)$/.exec(path);
  if (page && state.jobs.some((j) => j.handle === page[1])) return send(200, "text/html", "<html><body>job page</body></html>");
  return send(404, "text/html", "<html><body>Not found</body></html>");
}).listen(PORT, () => console.log(`Stub careers site on http://localhost:${PORT} (${state.jobs.length} jobs)`));
