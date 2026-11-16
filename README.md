# MAPLE

A small stack for database-backed apps that people use through their AI assistant.

| Letter | Part | What it means |
|---|---|---|
| **M** | MCP first | The app's main door is an MCP server, so people use it from Claude (or any MCP client). A web dashboard is optional. |
| **A** | Auth | Sign-in by a code sent by email: no passwords. The same sign-in protects the dashboard and the MCP connection (OAuth). |
| **P** | Postgres | One relational database per app, with limits. |
| **L** | Loop | The people who use the app can ask its maker for changes from inside the chat. Each ask is stored, emailed to the maker with a ready-to-run agent prompt, and closed with a reply when done. |
| **E** | Email | Email carries the sign-in codes and the loop's asks. |

Around those five: functions (the app's code), scheduled jobs, secrets and a custom domain.

## Why

Most people don't want another app to learn. They want to ask a question in plain English and get
an answer from their own data, and to say "can it also do this?" and have that happen. A shop
asking what to reorder, a clinic checking tomorrow's bookings, a club chasing unpaid fees, a team
tracking its jobs: same shape every time. MAPLE apps are built for that: the assistant is the
interface, the database holds what matters, and the loop is how the app grows.

## What's here

- [SPEC.md](SPEC.md): what makes an app a MAPLE app (the rules).
- [maple.schema.json](maple.schema.json): the manifest format, `maple.json`.
- [examples/](examples/): manifests for a shop's stock assistant (`shop.json`), a members' club
  (`club.json`) and an internal tool for a technical team (`team-tools.json`).
- [PROVIDERS.md](PROVIDERS.md): how each part maps onto Neon, Google Cloud, or a local Docker setup.

- [plans/grove-and-code-tools.md](plans/grove-and-code-tools.md): plan for apps that edit their own
  code over MCP, and Grove, a parent connection that creates new apps.

Status: draft 0.1. Describes the format only; no tooling yet.

## Licence

MIT. See [LICENSE](LICENSE).
