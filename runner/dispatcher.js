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
    // And the sign-in service's public keys, to check a token.
    if (url.hostname === "signin.runner") return this.env.SIGNIN.fetch("http://signin/jwks");
    return new Response("This app can't reach the internet.", { status: 403 });
  }
}

export default {
  async fetch(request, env, ctx) {
    // The runner's own server has already worked out which app this is for and says so in a header
    // that it strips from anything arriving from outside.
    const app = request.headers.get("x-runner-app");
    if (!app) return new Response("There is no app at this address.", { status: 404 });
    const version = request.headers.get("x-runner-version");
    const worker = env.LOADER.get(`${app}:${version}`, async () => {
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
