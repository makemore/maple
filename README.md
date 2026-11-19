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
asking what to reorder, a clinic checking tomorrow's bookings, a club chasing unpaid fees and a team
tracking its jobs all want the same thing. In a MAPLE app the assistant is the interface, the data
lives in the database, and the loop is how people ask for more.

## What's here

- [SPEC.md](SPEC.md): what makes an app a MAPLE app (the rules).
- [maple.schema.json](maple.schema.json): the manifest format, `maple.json`.
- [examples/](examples/): manifests for a shop's stock assistant (`shop.json`), a members' club
  (`club.json`) and an internal tool for a technical team (`team-tools.json`).
- [PROVIDERS.md](PROVIDERS.md): how each part maps onto Neon, Google Cloud, or a local Docker setup.


- [kit/](kit/): the MAPLE kit, the code every app carries for the five parts, plus background work ([kit/tasks.ts](kit/tasks.ts)) and the services an app can ask its host for ([kit/services.ts](kit/services.ts)).
- [template/](template/): the app every new app starts from.
- [grove/](grove/): Grove, the service that makes MAPLE apps from a chat. See [grove/README.md](grove/README.md).
- [tests/](tests/): `npm test` runs them.

Status: draft 0.1.

## Licence

Two licences, by folder:

| What | Where | Licence |
|---|---|---|
| MAPLE: the format, the kit, the template, the examples, and everything else outside `grove/` | this repository | MIT, see [LICENSE](LICENSE) |
| Grove: the service that makes and hosts apps | [`grove/`](grove/) | AGPL 3.0, see [grove/LICENSE](grove/LICENSE) |

MAPLE is MIT because its code is copied into every app, and those apps belong to whoever makes them,
to use however they like. Grove is AGPL so that anyone can run their own, and anyone who runs a
changed version as a service shares what they changed.
