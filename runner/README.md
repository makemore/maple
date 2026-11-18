# Grove's shared runner

Where free apps are meant to live: not a project each, but stored code and their own tables in a
shared Postgres, loaded and run on demand. An idle app costs a few kilobytes of disk.

Two small services on Cloud Run, built from the same image:

- **The desk** ([server.mjs](server.mjs)) holds the credentials. It runs Grove's own sign-in
  ([signin.mjs](signin.mjs), built on Better Auth: an emailed code, and the OAuth steps an AI
  assistant goes through), keeps each app's code and tables ([db.mjs](db.mjs)), does what Grove
  asks (store, trial copy, export, delete), and decides whether a request may run at all.
- **The sandbox** ([boxes.mjs](boxes.mjs), [dispatcher.js](dispatcher.js)) is the only place app
  code runs, each app in its own sealed box (`workerd`), loaded when first asked for. It holds no
  database password, no sign-in keys and no way to manage apps, and its Google account can read
  nothing. What an app needs from outside (its code, its queries, sign-in's public keys) the
  sandbox asks the desk for, showing a short-lived pass the desk issued for that one app
  ([sandbox.mjs](sandbox.mjs)). So code that broke out of its box would find only passes for the
  apps in use at that moment.

Apps are the same MAPLE apps, with the same kit. [build.mjs](build.mjs) bundles one for the runner
by swapping four host-specific packages for the stand-ins in [shims/](shims/).

Requests arrive through Grove's front door on Cloudflare ([../edge](../edge)); the runner refuses
anything that didn't.

## Status

Live: Grove creates every free-plan maker's new app here, with trial copies, shipping, undo, pause,
hand-over, export and delete. Email, files and background work go through Grove as for any app.

Limits on each app: requests and database queries a day, how many requests at once, processor time
and total time per request, time per query, rows and bytes per result.

Memory: an app that has been used stays loaded, about 14 MB each (measured). So the runner holds a
set number of apps per sandbox (`MAX_WARM_APPS`), then starts a fresh sandbox and closes the old
one once it is idle. At most two exist at a time.

Not done: a memory limit on one app by itself (a greedy app can still take the sandbox down, which
then restarts), and spreading apps over more than one database server.

## Commands (from the repo root)

```bash
npm run test:runner        # the whole way through, locally, against Postgres in Docker
npm run deploy:runner      # build and deploy the service
npm run test:live:runner   # the whole way through against the deployed service
```

Settings the desk needs: `DATABASE_URL` (the shared Postgres, as its owner), `RUNNER_SECRET`
(32+ characters; app logins and sign-in keys depend on it, so it must never change),
`SIGNIN_URL`, `APPS_DOMAIN`, `EDGE_SECRET`, `POSTMARK_TOKEN`, `RUNNER_ADMIN_TOKEN`, `GROVE_URL`,
`SANDBOX_URL`, `SANDBOX_TOKEN`. The sandbox needs only `DESK_URL`, `SANDBOX_TOKEN` and `GROVE_URL`.
