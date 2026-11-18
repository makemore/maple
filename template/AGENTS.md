# Building this app

A MAPLE app: people use it from their AI assistant (MCP first), sign in with an emailed code, and
its data lives in Postgres. They can ask the maker for changes from the chat (the loop).

## Where things go

| File | What | Change it? |
|---|---|---|
| `src/app.ts` | This app's tables (`schema`), what the assistant should know (`guide`), its tools, its web pages and routes | Yes: features go here |
| `src/*.ts` | More of the app's own code, if `app.ts` gets long | Yes |
| `maple.json` | Name, maker, who can sign in, description | Description and title, yes |
| `neon.ts` | Settings for deploying this app yourself with Neon's tools | Rarely |
| `src/maple/` | The MAPLE kit: sign-in, people, the loop, pages | No: comes from MAPLE |

## Adding a feature

1. Tables: add to `schema`, always `create table if not exists`; add columns with
   `alter table ... add column if not exists`. Never drop or delete in the schema.
2. Tools: `server.registerTool(name, { title, description, inputSchema }, handler)`, with zod
   inputs. The description is how the assistant learns the tool: say what it does, when to use it,
   units, and what happens to fields left out. Tools that change data say so and ask to confirm.
3. Return `json(data)`: it adds the plain-English reminder for the assistant.
4. Use `ctx.person.email` for who is asking and `ctx.isMaker` for maker-only tools.
5. Update `guide` so the assistant knows the new feature exists.
6. Import only the app's own files, Node's built-ins, and the packages already in `package.json`.
   Adding a package to `package.json` does nothing when Grove builds the app.

Example:

```ts
export const schema = `
create table if not exists notes (id serial primary key, body text not null, author text not null,
  created_at timestamptz not null default now());`;

export function tools(server: McpServer, { pool, person, json }: Ctx) {
  server.registerTool("add_note", {
    title: "Save a note",
    description: "Saves a short note. Confirm the wording first.",
    inputSchema: { body: z.string().min(1).max(2000) },
  }, async ({ body }) => {
    const { rows } = await pool.query("insert into notes (body, author) values ($1, $2) returning *", [body, person.email]);
    return json(rows[0]);
  });
}
```

## Web pages

The app can be a website too. In `src/app.ts`:

- `home`: set it to a function returning a whole HTML page and it becomes the public front page
  at `/`. The signed-in page then moves to `/account`.
- `routes(app, pool)`: add pages and endpoints on the Hono `app`, such as
  `app.get("/menu", async (c) => c.html(page(await pool.query(...))))` or a form's
  `app.post("/sign-up", ...)`.

Anyone on the internet can open a path unless it starts with `/api/`, which needs sign-in. So a
public page shows only what the maker wants public, and a public form checks and limits what it
accepts (lengths, required fields, how many rows it will take). Escape everything from the
database or from a visitor before putting it in HTML. Write plain HTML and CSS in the page itself:
no build step, no outside scripts needed. Don't use `/`, `/account`, `/auth/`, `/mcp` or
`/.well-known/`: the kit owns them.

## Things Grove does for the app

`services` (in a tool's `ctx`, and the third argument of `routes`) has what would otherwise need
accounts and keys. `src/maple/services.ts` lists every call with its inputs and results.

| Service | Real? | For |
|---|---|---|
| `services.email.send({ to, subject, text })` | Yes | Confirmations, reminders, anything by email. Plain text, up to 10 addresses a call, a daily limit per app. |
| `services.tasks.later(name, payload, { inMinutes })`, `.every(name, { hours } or { dailyAt })` | Yes | Work that runs later or on a timer. See below. |
| `services.files.put({ name, type, base64, public })`, `.link(id)`, `.remove(id)` | Yes | Keeping photos and documents, up to 4 MB each. Store the `id` in a table; a private file needs a fresh `link` each time it is shown. |
| `services.payments.checkout(...)`, `.status(id)` | Pretend | Taking a card payment on a page Grove hosts. |
| `services.texts.send(...)` | Pretend | Text messages to phones. |
| `services.ai.ask(...)` | Pretend | Sorting or summarising what people typed. |
| `services.pdf.make(...)` | Pretend | Invoices, certificates, anything to print. |

A pretend service answers in the shape the real one will, with `mock: true` and a `note`. Build
with it, and always pass the note on: say plainly that no money moved, no text was sent, or the
job won't run yet. Never present a pretend result as real. The pretend payment page lets the
person press "pretend it was paid", so a whole payment flow can be tried.

Email is real, so treat it with care: only email people who expect it, never in bulk, and say in
the tool description that the tool sends email. On a trial copy, only the app's own people are
emailed; other addresses come back in `held`.

### Background work

Add the work to `jobs` in `src/app.ts`, then start it from a tool or a route:

```ts
export const jobs: AppJobs = {
  remind: async ({ orderId }, { pool, services }) => {
    const { rows: [o] } = await pool.query("select email, total from orders where id = $1 and paid_at is null", [orderId]);
    if (o) await services.email.send({ to: o.email, subject: "Your order is waiting", text: `...` });
  },
};
// in a tool:  await services.tasks.later("remind", { orderId }, { inMinutes: 60 * 24 });
// on a timer: await services.tasks.every("daily_summary", { dailyAt: "08:00" });  // UTC
```

A job has no signed-in person. If it throws it is tried again, up to five times, so make it safe
to run twice (check the row still needs doing). Jobs run within a minute or so of their time, not
to the second. Start a repeating job from a maker's tool, not on every request: calling `every`
again with the same name replaces the old timing. The kit gives the maker a `jobs` tool to see
what is waiting and what failed. Jobs live in the app's own database, so they go wherever the app
goes; outside Grove, `src/maple/tasks.ts` says what has to call the app to run them.

Don't add other ways of doing these (your own Stripe or email keys, `setTimeout` or `setInterval` for later work):
the app has nowhere to keep secrets and stops running between requests.

## Checks and deploys

Grove keeps this code, checks it and deploys it. Saving a change checks the types and imports
straight away and puts up a preview with its own copy of the database; shipping the change makes it
the live app. Tests (`src/*.test.ts`) are not run by Grove; `npm run check` runs them if you have
the code on your own computer.

## Talking to people

Unless `maple.json` says `"audience": "technical"`, the people using the app know nothing about
software. Tool descriptions and results should let the assistant answer in plain English.
