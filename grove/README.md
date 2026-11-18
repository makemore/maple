# Grove

Grove makes [MAPLE](../README.md) apps from a chat. A person adds Grove to their AI assistant, says
what they need, and gets a small app with its own database, sign-in for the people they choose, and
its own address. Grove is itself a MAPLE app. The hosted one is at [makewithgrove.com](https://makewithgrove.com).

## What it does

- **Makes apps.** `create_app` starts an app from the template in [`../template`](../template), in its own Neon project.
- **Keeps the code.** Every saved change and every shipped state is a whole version in Grove's database. No git account is needed.
- **Builds inside itself.** Code is type-checked and bundled in the function ([`src/build.ts`](src/build.ts)) and refused if it has problems.
- **Previews, ships, undoes.** Each change gets a preview on its own copy of the database. Shipping combines changes file by file; rolling back makes a new version.
- **Hands apps over.** `export_app` gives the code as a zip and the address of the database.
- **Passes apps on.** `give_app` offers an app to another person, such as the client it was made for; `accept_app` makes it theirs.
- **Does the awkward parts for apps.** Email is sent through Grove ([`src/services.ts`](src/services.ts)), and a one-minute timer wakes any app with background work due. Payments, files, text messages, AI and PDFs answer in a pretend mode for now.
- **Has a front door on Cloudflare.** [`../edge`](../edge) is a small Worker that app addresses can go through, so traffic limits apply before a request reaches an app. It asks Grove where each app lives.
- **Looks after the service.** Plans and payment through Stripe, terms people agree to, limits, reports, pausing, and a count of how much of a person's assistant allowance the work uses.

## Running your own

You need a Neon organization and the Neon CLI. Copy the settings listed in [`neon.ts`](neon.ts) into
`.env.grove` at the top of the repository, then from there:

```sh
npm install
npm test            # unit tests
npm run deploy:grove
```

`neon.ts` says what each setting is for. Only the Neon key, the organization and `GROVE_SECRET` are
required; payments, email, the apps domain and the terms pages switch on when their settings are present.

## Licence

Grove (everything in this folder) is under the GNU Affero General Public License, version 3. See
[LICENSE](LICENSE). In short: you may use, change and run it, including as a service for others, and
if you run a changed version as a service you must offer its users the source of your version.

The apps Grove makes are not covered by this licence. They are built from the MAPLE kit and template,
which are MIT, and they belong to the people who make them.
