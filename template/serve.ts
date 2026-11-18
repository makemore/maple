// Runs the app as a plain Node server, for hosting it anywhere other than Neon (a VM, Cloud Run, Fly,
// Railway...). Grove and `neon deploy` don't use this file. Start it with: npm start (PORT, default 3000).
import { createServer } from "node:http";
import { Readable } from "node:stream";
import app from "./src/index.ts";

const port = Number(process.env.PORT ?? 3000);
createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host ?? `localhost:${port}`}${req.url ?? "/"}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : (Readable.toWeb(req) as ReadableStream);
    const answer = await app.fetch(new Request(url, { method: req.method, headers, body, duplex: "half" } as RequestInit));
    res.writeHead(answer.status, Object.fromEntries(answer.headers));
    if (answer.body) Readable.fromWeb(answer.body as never).pipe(res);
    else res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end("Something went wrong.");
  }
}).listen(port, () => console.log(`Listening on http://localhost:${port}`));
