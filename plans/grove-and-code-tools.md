# Plan: apps that edit themselves, and Grove, the app that makes apps

Draft, 2026-11-15. Not started.

Two pieces, both MCP connections:

1. **Code tools** inside every MAPLE app: the maker's own assistant (Claude in claude.ai, or any
   MCP client) reads and changes the app's code through the app's MCP connection, with the live
   data alongside, and ships through git and CI.
2. **Grove**, a parent MCP connection: "make me an app that does X" creates the git repository,
   the database project, sign-in, secrets, CI and the first deploy, then hands back the new app's
   connection address. From then on the new app's own code tools take over.

Together: people use their own agents to set up and grow apps for agents, without touching a
terminal or a cloud console.

```
 person's assistant
    |  "make me a club helper"          |  "add a fee reminder"
    v                                   v
  Grove (MCP) ---- creates ----->  the new app (MCP)
    | GitHub repo from template         | code_* tools -> branch -> CI
    | Neon project, auth, secrets       | preview -> ship -> rollback
    | CI secrets, first deploy          | the app's own data tools
    | domain, people                    | the loop (ask the maker)
```

## Part 1: code tools in each app

### Tools

Offered only to people with the `maker` role (the maker's sign-in, or a list in the manifest).

| Tool | Does |
|---|---|
| `code_list` | Files in the app's repository, at main or a working branch |
| `code_read` | One file (or a line range) |
| `code_search` | Search the code |
| `code_edit` | Replace exact text in a file, or write a new file, on a working branch (`change/<slug>`) |
| `code_commit` | Commit the branch with a message; CI starts |
| `code_checks` | CI status and failing output for the branch |
| `code_preview` | Preview address for the branch (its own database branch and function) |
| `code_ship` | Merge to main once checks pass; CI deploys |
| `code_rollback` | Revert the last shipped change; CI deploys |
| `code_history` | Recent changes: who, what, when, linked loop asks |

### How it works

- The repository is the source of truth. The app writes only to git, through a GitHub App
  installed on that one repository (contents and pull requests). The App's key is an app secret;
  the assistant never sees it.
- CI (GitHub Actions) runs the tests and the deploys. The app never builds or deploys itself.
  - Push to `change/*`: tests, then a preview deploy on a database branch named after it.
  - Merge to main: tests, deploy, smoke check.
- Changes land as pull requests, so there is a record and a diff; `code_ship` merges it.
- A shipped change can close a loop ask (`update_request`) with a plain-English reply.

### Guardrails (enforced by the server, not by instructions)

- Maker role only. Users who aren't makers keep the loop.
- Protected paths: auth and the allow-list check, the loop, limits, CI workflows and the code tools
  themselves. `code_edit` refuses them; changing them is a maker job in a normal coding session.
- No direct writes to main. `code_ship` refuses while checks are failing or pending.
- Database changes are additive only (new tables or columns); a CI check rejects drops and deletes
  in migrations.
- Size limits per edit and per change; a rate limit on commits per hour.
- Every tool call is logged with the signed-in person.
- Text from outside systems (product names, emails, synced records) is data. The tools' guidance
  says so, and a person reviews every change before it ships.

## Part 2: Grove, the parent connection

Grove is itself a MAPLE app (email-code sign-in, MCP first, its own database, the loop to its
maker), so it is built and run the same way as the apps it makes.

### Tools

| Tool | Does |
|---|---|
| `create_app` | Name, one-paragraph description, template. Creates everything (below) and returns the app's address and connection address. |
| `list_apps`, `app_status` | Your apps: health, last deploy, usage against limits, open asks |
| `add_person`, `remove_person` | Who can sign in to an app, and who is a maker |
| `secret_link` | A one-time web link where the person types a secret (API keys never go through chat) |
| `list_secrets` | Names and when each was set; never values |
| `add_domain`, `check_domain` | The DNS records to add at the registrar, then waits for the certificate |
| `pause_app`, `resume_app` | Stop and start (the database sleeps anyway) |
| `export_app` | A `pg_dump` and the repository, for moving elsewhere |
| `delete_app` | Asks to confirm with the app's name; keeps a final snapshot for 30 days |

### What `create_app` does

1. Repository: new private repo from the chosen template, in Grove's GitHub organization (or the
   person's own, through Grove's GitHub App).
2. Database: a Neon project (Agent plan: the free organization for free users, paid for paying
   ones), region near the person.
3. Sign-in: Neon Auth with email codes, the allow list set to the person, trusted domains, the
   OAuth server for MCP pointed at the app's connection address.
4. Secrets: Grove's own (email token, GitHub App key) set on the function; CI gets a deploy key
   scoped to this one project.
5. `maple.json` filled in from the answers; first deploy through CI; smoke check.
6. Returns: the dashboard address, the connection address to add in Claude, and a two-line "what
   to do next".

The person adds the new connection in Claude themselves (Settings, Connectors): Grove can't do that
for them. From there they talk to the new app, and as its maker they can grow it with its code tools.

### Templates

- `blank`: MAPLE parts only (sign-in, MCP, the loop, an empty dashboard).
- `mcp-dashboard`: BK Buddy without the shop: a sync job, data tools, a dashboard with tiles.
- More later, each a repository marked as a template.

### Limits and abuse

- Who may create apps: an allow list at first (invite only).
- Per person: number of apps, storage, monthly spend; Grove refuses past them and says why.
- Free apps go in Neon's free organization, so an idle free app costs nothing.
- Grove's loop tells its maker about unusual use (many apps, high spend).

## Where it runs

On Neon first (Functions, Auth, the Agent plan's two organizations), with the provider layer from
[PROVIDERS.md](../PROVIDERS.md) so Grove and its apps can move to Google Cloud later. Foundry
Studio can offer the same control plane through `studio app` (see the Foundry App plan in the
agents repository); Grove is the MCP door to it.

## Phases

1. **Code tools on BK Buddy, maker-only.** Put its code on GitHub with Actions (tests, preview,
   deploy, smoke); add the `code_*` tools behind the maker's sign-in; make one small change end to end
   from claude.ai.
2. **Template.** Lift BK Buddy into `mcp-dashboard` and `blank`, with the code tools built in.
3. **Grove, by hand.** `create_app` from a script first, to prove every step can be automated
   (repo, Neon project, auth, secrets, CI, deploy).
4. **Grove as an MCP app.** The tools above, sign-in, limits, invite-only.
5. **Spec.** Add code tools (optional part) and the creation contract to SPEC.md.

## Open decisions

- Whose GitHub organization holds the apps' repositories by default.
- Whether makers can also be the app's users in other apps (one Grove account, many apps).
- Pricing for paid apps, and when an app moves from the free organization to the paid one.
- The name: Grove (the parent) and MAPLE (the apps).
