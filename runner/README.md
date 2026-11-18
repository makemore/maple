# Grove's shared runner

Where free apps are meant to live: not a project each, but stored code and their own tables in a
shared Postgres, loaded and run on demand. An idle app costs a few kilobytes of disk.

One small service (Cloud Run, asleep when idle) does two jobs:

- **Sign-in** ([signin.mjs](signin.mjs)): Grove's own sign-in service, built on Better Auth. An
  emailed code to sign in, and the OAuth steps an AI assistant goes through to act for someone in
  one app. Each app is a row, so any number can share it.
- **Running apps** ([sandbox.mjs](sandbox.mjs), [dispatcher.js](dispatcher.js)): each app's code is
  loaded into its own sealed box (`workerd`) when first asked for. It has no database password and
  no internet. Its queries go to the runner, which runs them as that app's own login
  ([db.mjs](db.mjs)), able to reach nothing but that app's schema.

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

Not done: a memory limit on one app by itself (a greedy app can still take the whole sandbox down,
which then restarts), and spreading apps over more than one database server.

## Commands (from the repo root)

```bash
npm run test:runner        # the whole way through, locally, against Postgres in Docker
npm run deploy:runner      # build and deploy the service
npm run test:live:runner   # the whole way through against the deployed service
```

Settings the service needs: `DATABASE_URL` (the shared Postgres, as its owner), `RUNNER_SECRET`
(32+ characters; app logins and sign-in keys depend on it, so it must never change),
`SIGNIN_URL`, `APPS_DOMAIN`, `EDGE_SECRET`, `POSTMARK_TOKEN`.
