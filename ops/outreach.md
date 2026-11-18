# Outreach loop

One pass finds a few businesses whose websites could move to Grove, makes each a private preview, and leaves
an email draft for Chris to read, personalise and send by hand. Nothing is ever sent automatically.

Everything goes through Grove's command line (`node cli/grove.ts`, logged in as Grove's maker; for a first
login, `scripts/cli-token.ts`).

## Each pass

1. **What happened since last time.** `node cli/grove.ts prospects`. Report what was claimed, declined or
   expired. For each `ready` prospect with a Gmail draft that Chris has since sent (search Sent mail for its
   preview link), record it: `prospect_update --id N --what emailed`. Never send a second email to anyone.
2. **Find up to 5 new businesses** (stay well under the weekly cap of 25). Each one must be:
   - a **limited company** (company number or "Ltd" in the site footer, or on Companies House), because UK rules
     let us write cold only to companies, with an opt-out. No sole traders, partnerships or individuals;
   - a brochure site on Squarespace, Wix, Webflow, GoDaddy or paid WordPress hosting (`survey_site` says which).
     No shops (Shopify, or a site-builder store with a cart), no members' areas, nothing that needs logins;
   - not in health, finance, legal, government, children's services or anything regulated;
   - showing a **public business contact address** on its own site (info@, hello@, office@). No personal
     addresses, nothing from a data broker.
   Good places: local trades, cafés, studios, clubs, consultancies. Note where each came from.
3. **Make the preview.** `node cli/grove.ts prospect_site --url ... --business "..." --contact ... --note "..."`,
   then after a minute `prospects`. Open each preview and look at it: if it looks broken (missing styles,
   empty pages), `prospect_update --id N --what delete` and leave that business out.
4. **Write the draft.** `node cli/grove.ts prospect_email --id N --from Chris`. Add one sentence that shows a
   person looked at their site (something specific and true about the business), keep the rest as it is, and
   put it into a Gmail draft to the contact address. Don't send it.
5. **Tell Chris** what's waiting: business, site, platform, why it was picked, and the draft's subject.

## Stop

Stop the loop and tell Chris at the first complaint, or if a business replies upset. If anyone asks to be
left alone, `prospect_update --id N --what declined` records it so Grove never writes to them again.

Before the first emails go out, `GROVE_LEGAL_NAME` and `GROVE_CONTACT_EMAIL` must be set on Grove, so the
email says who is writing in law (`prospect_email` warns until they are).
