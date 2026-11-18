// The runner's front desk, inside the sandbox runtime. For each request it works out which app is
// wanted, loads that app's code if it isn't already warm, and hands the request over. The app gets
// no database password and no internet: everything it sends out comes back through Outbound below.
import { WorkerEntrypoint } from "cloudflare:workers";

export class Outbound extends WorkerEntrypoint {
  async fetch(request) {
    const { app } = this.ctx.props;
    const url = new URL(request.url);
    // The only place an app may call: the runner's database desk, which runs the query as this app's own login.
    if (url.hostname === "db.runner") return this.env.DBGW.fetch("http://gateway/query", { method: "POST", headers: { "x-app": app }, body: await request.text() });
    return new Response("This app can't reach the internet.", { status: 403 });
  }
}

export default {
  async fetch(request, env, ctx) {
    const app = new URL(request.url).hostname.split(".")[0];
    const about = await (await env.CODE.fetch(`http://code/${app}?meta=1`)).json();
    if (!about.version) return new Response("There is no app at this address.", { status: 404 });
    const worker = env.LOADER.get(`${app}:${about.version}`, async () => {
      const { code, env: appEnv } = await (await env.CODE.fetch(`http://code/${app}`)).json();
      return {
        compatibilityDate: "2026-06-01",
        compatibilityFlags: ["nodejs_compat", "nodejs_compat_populate_process_env"],
        mainModule: "index.js",
        modules: { "index.js": code },
        env: appEnv,
        globalOutbound: ctx.exports.Outbound({ props: { app } }),
      };
    });
    return worker.getEntrypoint().fetch(request);
  },
};
