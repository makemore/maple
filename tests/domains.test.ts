// People's own domains for their apps: which names are allowed, and what Cloudflare's answers mean.
import assert from "node:assert/strict";
import { test } from "node:test";
import { describe, domainProblem } from "../grove/src/tools-domains.ts";

test("domains: real names with something in front; not Grove's own, not banks or brands, not bare", () => {
  process.env.APPS_DOMAIN = "grovehelper.com";
  assert.deepEqual(domainProblem("https://WWW.RiverRowing.club/about"), { domain: "www.riverrowing.club" });
  assert.match(domainProblem("riverrowing.club").problem!, /something in front/);
  assert.match(domainProblem("x.grovehelper.com").problem!, /Grove's own/);
  assert.match(domainProblem("www.makewithgrove.com").problem!, /Grove's own/);
  assert.match(domainProblem("login.paypal.com").problem!, /won't serve/);
  assert.match(domainProblem("www.hmrc.gov.uk").problem!, /won't serve/);
  assert.match(domainProblem("not a domain").problem!, /isn't a domain/);
});

test("domain status in plain words", () => {
  assert.equal(describe({ status: "active", ssl: { status: "active" } }).status, "live");
  assert.equal(describe({ status: "pending", ssl: { status: "pending_validation", validation_records: [{}] } }).status, "waiting");
  assert.match(describe({ status: "pending", verification_errors: ["custom hostname does not CNAME to this zone."] }).note, /does not CNAME/);
  assert.equal(describe({ status: "blocked" }).status, "stopped");
});
