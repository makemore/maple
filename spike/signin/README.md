# Spike: one sign-in service for any number of apps

Question: Neon's sign-in service accepts at most ten app addresses per project
(`OAUTH_PROVIDER_TOO_MANY_RESOURCES`, measured on a throwaway project). Can Grove run its own, so
thousands of free apps share one sign-in?

Answer: yes, on a laptop, with Better Auth, the open-source software Neon's sign-in is built on.
Each app is a row in a table, so there is no ceiling.

## Run it

```bash
docker run -d --name grove-spike-pg -e POSTGRES_PASSWORD=spike -p 54329:5432 postgres:17
cd spike/signin && npm install && node run.mjs
docker rm -f grove-spike-pg
```

## What was shown

With 2,000 apps registered, the script does what an assistant does when it connects to an app:

1. registers itself, with no account and no secret;
2. is sent to the sign-in page, because nobody is signed in;
3. the person signs in with a code sent to their email;
4. the person agrees the assistant may act for them;
5. the assistant swaps its one-time code for a token.

The token is good for that one app, carries the person's verified email, and can be checked by
anyone against the service's public keys. It is refused at any other app. A token for an address
that is not one of the apps is refused. A code used twice is refused. Refreshing works.

That token has the shape `../shared-runner` already accepts (`email`, `email_verified`, the app's
address as audience), so the two fit together. They have not been joined in one run yet.

## What it did not show

- **A real assistant.** The script plays the assistant's part. Claude and ChatGPT have to be tried
  against a deployed copy, and they are particular about the details.
- **The pages.** There is no sign-in or consent page here, only the calls behind them. The kit's
  existing pages do the same calls against Neon and should move over with small changes.
- **Sending email.** The code is caught in memory, not sent.
- **Running anywhere but a laptop**, and any thought about its own limits against abuse
  (anyone can register an assistant; that is how assistants work, but it needs a rate limit).
