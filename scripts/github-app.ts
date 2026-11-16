// One-time setup: creates Grove's GitHub App on the apps' organization with GitHub's manifest flow,
// and saves its id and key into .env.local (never printed). Run: node scripts/github-app.ts maple-apps
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

const org = process.argv[2];
if (!org) throw new Error("Usage: node scripts/github-app.ts ORG");
const port = 8787;
const envFile = new URL("../.env.local", import.meta.url).pathname;
if (existsSync(envFile) && /^GITHUB_APP_ID=/m.test(readFileSync(envFile, "utf8"))) throw new Error(".env.local already has a GitHub App; remove those lines first to make a new one.");

const manifest = {
  name: `Grove for ${org}`,
  url: "https://github.com/makemore/maple",
  redirect_url: `http://localhost:${port}/callback`,
  public: false,
  hook_attributes: { url: "https://example.com/unused", active: false },
  default_events: [],
  // Create repos, write code and workflows, set Actions secrets and variables, read runs and statuses.
  default_permissions: {
    administration: "write",
    contents: "write",
    workflows: "write",
    secrets: "write",
    actions_variables: "write",
    actions: "read",
    statuses: "read",
    metadata: "read",
  },
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const page = `<!doctype html><meta charset="utf-8"><title>Create Grove's GitHub App</title>
<body style="font:16px system-ui;max-width:520px;margin:10vh auto;padding:16px">
<h1>Create Grove's GitHub App</h1>
<p>This creates a private GitHub App on <b>${esc(org)}</b> that Grove uses to make app repositories and ship changes to them.</p>
<form action="https://github.com/organizations/${esc(org)}/settings/apps/new" method="post">
<input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}">
<button style="font:inherit;padding:10px 16px">Continue to GitHub</button></form>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (url.pathname === "/") return res.writeHead(200, { "content-type": "text/html" }).end(page);
  if (url.pathname !== "/callback") return res.writeHead(404).end();
  const code = url.searchParams.get("code");
  const r = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, { method: "POST", headers: { accept: "application/vnd.github+json" } });
  if (!r.ok) {
    res.writeHead(500, { "content-type": "text/plain" }).end(`GitHub said ${r.status}. Close this and run the script again.`);
    return;
  }
  const a = await r.json();
  appendFileSync(envFile, `\nGITHUB_ORG=${org}\nGITHUB_APP_ID=${a.id}\nGITHUB_APP_SLUG=${a.slug}\nGITHUB_APP_PRIVATE_KEY="${a.pem.trim().replace(/\n/g, "\\n")}"\n`, { mode: 0o600 });
  console.log(`Saved GitHub App ${a.slug} (id ${a.id}) to .env.local.`);
  res.writeHead(302, { location: `https://github.com/apps/${a.slug}/installations/new` }).end();
  setTimeout(() => process.exit(0), 500);
});
server.listen(port, () => console.log(`Open http://localhost:${port} to create the App.`));
