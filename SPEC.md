# MAPLE specification, draft 0.1

The key words MUST, SHOULD and MAY are used as in RFC 2119.

People in this document:

- **User**: anyone who signs in and uses the app through their assistant. Unless the manifest says
  otherwise (`mcp.audience`), users are assumed to know nothing about AI agents, MCP or software.
- **Maker**: the person (or team) who builds and looks after the app.

## 1. Manifest

An app MUST have a `maple.json` at its root, valid against [maple.schema.json](maple.schema.json).
It declares the parts the app uses; a provider (see [PROVIDERS.md](PROVIDERS.md)) reads it to set
them up. Secret values MUST NOT appear in it, only their names.

## 2. M: MCP first

- The app MUST serve an MCP endpoint over Streamable HTTP, at `mcp.path` (default `/mcp`).
- The endpoint MUST be an OAuth 2.1 protected resource: `401` with a `WWW-Authenticate` header
  pointing at `/.well-known/oauth-protected-resource<path>`, whose `resource` is the public URL of
  the endpoint on the app's own domain.
- The server MUST send `instructions` on initialize. With the default audience (`everyone`) they
  MUST say: use plain English, no tool or field names, keep it short, and send anything technical
  to the maker through the loop. With `technical`, the app MAY drop the plain-English rules.
  The server MAY send different instructions when the signed-in person is the maker.
- Every tool result SHOULD carry the data as its first content item (JSON text) and a short style
  reminder as a second item, so the assistant keeps to plain English without being told each time.
- Tools that change data MUST say so in their description, and say what happens to fields left out.
- The server SHOULD advertise an icon (`icons` on server info).

## 3. A: Auth

- Sign-in MUST be by a one-time code sent by email. No passwords.
- Only addresses in `auth.allowed` (people) or ending in `auth.allowedDomains` MAY get in. The
  check MUST be made by the app on every request, not only at sign-in.
- The same identity MUST protect the dashboard (session) and the MCP endpoint (OAuth access token).
- The sign-in page SHOULD stop resending a code within 60 seconds.
- Consent screens MUST name the client asking and where it will send the person back to.

## 4. P: Postgres

- Each app MUST have its own Postgres database (or its own project), reached through
  `DATABASE_URL`. Apps MUST NOT share tables.
- The app MUST create its own tables idempotently on start, or ship migrations.
- Limits in `database.limits` MUST be enforced by the provider (storage, connections, statement
  time). Going over storage SHOULD make the app read-only, not delete anything.
- Data people enter (settings, rules, notes) MUST survive reseeding and resyncing from other systems.

## 5. L: Loop

The loop is how users ask the maker for things without leaving the chat.

### 5.1 Storage

The app MUST keep asks in its own database, in this table (column names are the contract):

```sql
create table if not exists requests (
  id serial primary key,
  created_at timestamptz not null default now(),
  sender text not null,                       -- signed-in email of the person asking
  kind text not null check (kind in ('upgrade','problem','question')),
  message text not null,                      -- the ask, in the user's words
  prompt text,                                -- an agent prompt for the maker, if one was written
  emailed boolean not null default false,
  status text not null default 'open' check (status in ('open','done','declined')),
  reply text,                                 -- what the maker says back, in plain English
  updated_at timestamptz
);
```

### 5.2 Tools

The MCP server MUST offer:

| Tool | Who | Does |
|---|---|---|
| `ask_maker` | everyone | `kind`, `message`, optional `agent_prompt`. Stores the ask, then emails the maker. |
| `list_requests` | everyone | Recent asks, optionally by `status`. |
| `update_request` | maker | `id`, `status`, optional `reply`. Closes the loop. |

A server MAY name `ask_maker` after the maker (for example `ask_chris`) so users can say
"ask Chris". The description MUST say what it is for: changes, problems, anything technical.

### 5.3 Email to the maker

- The ask MUST be stored before the email is sent, so nothing is lost if email fails; `emailed`
  records whether it went.
- The email goes to `loop.to`, with Reply-To set to the sender.
- Subject: `<app> #<id> <kind>: <first line of message>`.
- The body MUST include the ask, who sent it, and an agent prompt the maker can paste into their
  coding agent. That prompt MUST end by telling the agent to close the ask with `update_request`
  and id `<id>`, with a reply written for the user.
- Asks MUST be rate limited per day (`loop.dailyLimit`, default 20).

### 5.4 Visible to users

If the app has a dashboard, it SHOULD show the asks and their replies.

## 6. E: Email

- Email is used for sign-in codes (section 3) and the loop (section 5).
- The sender (`email.from`) MUST be on a domain with SPF, DKIM and a DMARC record.
- Provider tokens are secrets (section 8).

## 7. Functions, jobs and domain

- The app's code is one or more HTTP handlers (`fetch(request) => Response`), so it runs on any
  provider that hosts Node.
- Background work lives in the app's own database (the kit's `maple_tasks` table), so it moves with
  the app. The app does nothing between requests: something outside MUST call `POST /maple/tick`
  regularly (once a minute is plenty) to run what is due. Any scheduler will do: the provider's
  own, cron with curl, a CI timer. The app MUST refuse the call without the shared secret
  (`MAPLE_TICK_SECRET`, or the secret its provider gave it).
- A job MAY run more than once and late, never early: it is retried when it fails, so it MUST be
  safe to repeat.
- The app SHOULD be served on its own domain (`domain`), with `www.` redirecting to it. Links,
  OAuth resources and emails MUST use that domain, so moving provider is a DNS change.

## 8. Secrets

- `secrets` lists the names the app needs. Values live with the provider (or the maker's
  secret store), never in the repository, arguments or logs.
- A provider SHOULD offer pushing and pulling them (`.env.local` for local work).

## 9. Portability

- Provider-specific code SHOULD sit in one small file per part (auth checks, job checks, pool
  setup), so moving is a swap of those files.
- An app SHOULD also run on plain Node against a plain Postgres (for example in Docker) for tests.
- A provider SHOULD keep a regular `pg_dump` of each app outside itself.

## 10. Example data

- An app MAY run on example data before it is connected to real systems. Every result built from it
  MUST say so (for example `"example_data": true`), and the assistant MUST tell users.
