# Running this app without Grove

This app is ordinary code: a Node server (Hono) with a Postgres database. It runs anywhere Node 22+ and
Postgres do. Grove supplies a few things while it hosts the app; this page says what each one becomes
when you take the app away, and what you set up instead.

## What you need

| Part | While on Grove | After you leave | What to set up |
|---|---|---|---|
| Code | Kept and deployed by Grove | This folder | With Neon's tools, `neon deploy` (it reads `neon.ts`). Anywhere else, `npm install` then `npm start` runs `serve.ts`, a plain Node server on `PORT`. |
| Database | Grove's Postgres | Your Postgres | `DATABASE_URL`. Load your data from `export_app` (with database) using `psql "$DATABASE_URL" < data.sql`. Tables are created on start. |
| Sign-in (email codes, the assistant connection) | Neon Auth, set up by Grove | Neon Auth on your Neon project | `NEON_AUTH_BASE_URL` and `NEON_AUTH_JWKS_URL` (Neon fills these in on deploy). People sign in again once and reconnect their assistant. |
| Address | `<name>.grovehelper.com` | Yours | `PUBLIC_URL`, e.g. `https://app.example.com`. Point your DNS at the host. |
| Email | Sent by Grove | Postmark | `POSTMARK_TOKEN`, and `email.from` in `maple.json` set to an address on a domain you've verified in Postmark. Without them, email calls fail with a clear error. |
| Background jobs | Grove calls the app when a job is due | Any scheduler | `MAPLE_TICK_SECRET`, then call `POST /maple/tick` with `Authorization: Bearer <secret>` once a minute (cron, Cloud Scheduler, a GitHub Action). See `src/maple/tasks.ts`. |
| Files (photos, documents) | Kept by Grove | Not built in yet | `services.files` answers with a "pretend" result outside Grove. Copy files out first (their links are in your tables), then store new ones with your own S3-compatible storage in the app's code. |
| Payments, texts, AI, PDFs | Pretend services | Pretend | They return a result marked `mock: true` with a note. Replace each call with your own provider's SDK when you need the real thing. |
| The "Made with Grove" line | On free apps | Gone | Nothing: it only appears when Grove deploys the app. |

## Checklist

1. In Grove, `export_app` with the database, and download both links within the hour.
2. Create a Postgres database (Neon, or any other) and load `data.sql` into it.
3. Set the settings above on your host, then deploy this folder: `neon deploy`, or `npm install` and `npm start` on any Node 22.18+ host.
4. Point your address at it, and tell your app's people to remove and re-add the connection in their assistant.
5. Once it works, delete the app in Grove.

Nothing in the code calls Grove unless `GROVE_URL` is set, so leaving those settings out is enough to cut the tie.
