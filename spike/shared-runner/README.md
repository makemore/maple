# Spike: many free apps on one Postgres, run by a shared runner

Question: can Grove's free apps stop being one Neon project each, and instead be stored code and
tables that a shared runner loads when someone calls them? That is what would make an idle app
cost almost nothing.

Answer: yes, on a laptop. The same app code and the same MAPLE kit, unchanged, ran in a sealed box
(the open-source `workerd` runtime, loading each app's code on demand) against a plain Postgres 17
in Docker, with each app using its own limited login.

## Run it

```bash
docker run -d --name grove-spike-pg -e POSTGRES_PASSWORD=spike -p 54329:5432 postgres:17
cd spike/shared-runner && npm install
node --experimental-strip-types run.mjs
docker rm -f grove-spike-pg
```

## What was shown

- **The kit runs unchanged.** Four host-specific packages are swapped at build time for the small
  stand-ins in `shims/` (`pg`, `@neon/functions`, `@neon/oauth/mcp`, `@neon/oauth/mcp/hono`).
- **An app holds no database password.** Its queries go to the runner, which runs them as that
  app's own login. Which login is decided by the runner, never by anything the app sends.
- **One app cannot read another's data**, become another login, reach the internet, or hold the
  database with a slow query (a five-second limit per query).
- **Sign-in works per app.** A signed token is checked for the right issuer and the right app; a
  token for one app is refused at another; a person not on the app's list gets 403.
- **Speed.** First request to an app (code loaded, tables made): about 80 ms. Warm: 2 ms.

## What it did not show

- **A real sign-in service.** Tokens here are signed by a test key. The real thing needs one shared
  service that sends email codes and speaks OAuth to assistants (self-hosted Better Auth is the
  candidate). Not started.
- **Limits on CPU and memory.** `workerd` on its own does not cap how much a box may use, and its
  authors say it is not a complete security boundary by itself. The runner needs per-app limits and
  a second wall around it (Cloud Run's sandbox, or similar). Not measured.
- **Running on Google Cloud at all.** Everything here is local.
- **Trial copies, background work, files and email** on this path.
- **Load.** Two apps, forty requests.

## Two leaks to close before building on this

1. **Every app can read every person's email.** The kit looks people up in the sign-in service's
   table. It should take the email from the signed token instead. A kit change.
2. **Every app can see the names of other apps' logins** (`pg_roles`). Low harm, since app names
   are public addresses anyway, but logins should get names that say nothing.

## Things that will need care

- Query results cross to the app as JSON, so dates arrive as text, not date objects. The kit copes;
  app code written against `pg` directly may not.
- Bundles are about 1.5 MB each, mostly the kit's own packages. A million stored copies is a lot of
  the same bytes: store the kit once and each app's own code separately.
- The dynamic loading used here is new in `workerd` and needed a recent `miniflare` to drive it.
