# Building this app

A MAPLE app: people use it from their AI assistant (MCP first), sign in with an emailed code, and
its data lives in Postgres. They can ask the maker for changes from the chat (the loop).

## Where things go

| File | What | Change it? |
|---|---|---|
| `src/app.ts` | This app's tables (`schema`), what the assistant should know (`guide`), its tools, extra routes | Yes: features go here |
| `src/*.ts` | More of the app's own code, if `app.ts` gets long | Yes |
| `maple.json` | Name, maker, who can sign in, description | Description and title, yes |
| `neon.ts` | Function and scheduled jobs | Add jobs, yes |
| `src/maple/` | The MAPLE kit: sign-in, people, the loop, pages | No: comes from MAPLE |
| `.github/` | Checks and deploys | No |

## Adding a feature

1. Tables: add to `schema`, always `create table if not exists`; add columns with
   `alter table ... add column if not exists`. Never drop or delete in the schema.
2. Tools: `server.registerTool(name, { title, description, inputSchema }, handler)`, with zod
   inputs. The description is how the assistant learns the tool: say what it does, when to use it,
   units, and what happens to fields left out. Tools that change data say so and ask to confirm.
3. Return `json(data)`: it adds the plain-English reminder for the assistant.
4. Use `ctx.person.email` for who is asking and `ctx.isMaker` for maker-only tools.
5. Update `guide` so the assistant knows the new feature exists.
6. Add a test next to it (`src/*.test.ts`, `node:test`), for logic that isn't just SQL.

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

## Checks and deploys

`npm run check` (types and tests) runs on every push. A push to a `change/<name>` branch deploys a
preview with its own copy of the database; merging to `main` deploys the live app. The commit
status `maple/deploy` has the address (or the failing run).

## Talking to people

Unless `maple.json` says `"audience": "technical"`, the people using the app know nothing about
software. Tool descriptions and results should let the assistant answer in plain English.
