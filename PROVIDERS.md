# Providers

A provider turns `maple.json` into running parts. Three are described here; none is built yet.

| Part | Neon | Google Cloud | Local (Docker) |
|---|---|---|---|
| Postgres | A project per app | A database and role per app on a shared Cloud SQL instance; a sweep enforces size limits | `postgres` container |
| Auth (email code, OAuth for MCP) | Neon Auth (managed Better Auth), OAuth server | Better Auth, self-hosted, with its OAuth provider | Better Auth in the app; codes printed to the log |
| Functions | Neon Functions | Cloud Run, one service per app | `node` container |
| Jobs | Function triggers (schedule) | Cloud Scheduler with an OIDC token | A cron container calling the app |
| Secrets | Function env, set on deploy | Secret Manager | `.env.local` |
| Email | Postmark (or any SMTP) | Postmark (or any SMTP) | Mailpit container |
| Domain | Functions custom domains | Shared HTTPS load balancer and Certificate Manager | `localhost` |
| Limits | Per-project quotas through the API | Role connection limits, `statement_timeout`, size sweep | None |
| Backups | Instant restore; plus a `pg_dump` kept elsewhere | Cloud SQL backups; plus a `pg_dump` | None |

## Moving between providers

- Data: `pg_dump` and restore, or logical replication for no downtime.
- Accounts: Better Auth's tables move with the database. If the old provider's signing keys can't be
  exported, people sign in again and reconnect their assistant once.
- Code: swap the provider files (auth check, job check, pool setup); see SPEC section 9.
- Domain: change the DNS record.
