// The front desk inside the sandbox runtime. For each request it loads that app's code if it isn't
// already warm and hands the request over. The app gets no database password and no internet:
// everything it sends out comes back through Outbound below, which may only reach the runner's
// desk (showing the app's current pass) and Grove's own services.
import { WorkerEntrypoint } from "cloudflare:workers";

// The newest pass seen for each app. A pass says which app it is for and soon runs out; the desk
// issues a new one with every request and is the only one who can check them.
const passes = new Map();

export class Outbound extends WorkerEntrypoint {
  async fetch(request) {
    const { app } = this.ctx.props;
    const url = new URL(request.url);
    const pass = { "x-runner-pass": passes.get(app) ?? "" };
    if (url.hostname === "db.runner") return this.env.DBGW.fetch("http://desk/query", { method: "POST", headers: pass, body: await request.text() });
    if (url.hostname === "signin.runner") return this.env.SIGNIN.fetch("http://desk/jwks", { headers: pass });
    // Grove's own services for apps (email, files, and saying when a background job is due).
    if (this.env.GROVE_ORIGIN && url.origin === this.env.GROVE_ORIGIN && (url.pathname.startsWith("/services/") || url.pathname === "/api/notify")) return fetch(request);
    return new Response("This app can't reach the internet.", { status: 403 });
  }
}

export default {
  async fetch(request, env, ctx) {
    const app = request.headers.get("x-runner-app"), version = request.headers.get("x-runner-version"), pass = request.headers.get("x-runner-pass");
    if (!app || !pass) return new Response("There is no app at this address.", { status: 404 });
    passes.set(app, pass);
    const worker = env.LOADER.get(`${app}:${version}`, async () => {
      const { code, env: appEnv } = await (await env.CODE.fetch("http://desk/code", { headers: { "x-runner-pass": pass } })).json();
      return {
        compatibilityDate: "2026-06-01",
        compatibilityFlags: ["nodejs_compat", "nodejs_compat_populate_process_env"],
        mainModule: "index.js",
        modules: { "index.js": code },
        env: appEnv,
        globalOutbound: ctx.exports.Outbound({ props: { app } }),
        // How much processor time one request may use before it is stopped.
        limits: { cpuMs: Number(env.CPU_MS) || 2000 },
      };
    });
    // The app never sees the pass or the runner's own headers.
    const headers = new Headers(request.headers);
    for (const h of ["x-runner-app", "x-runner-version", "x-runner-pass", "x-runner-host"]) headers.delete(h);
    return worker.getEntrypoint().fetch(new Request(request, { headers }));
  },
};
