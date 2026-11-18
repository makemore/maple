// Grove's terms and privacy pages, and the record of who agreed to them.
// Both are drafts until GROVE_LEGAL_NAME and GROVE_CONTACT_EMAIL are set: until then the pages say so
// and nobody is asked to agree. Change TERMS_VERSION when the meaning changes: everyone is asked again.
import type { Pool } from "pg";
import { shell } from "./site.ts";

export const TERMS_VERSION = "2026-11-17";

export const LEGAL_SCHEMA = `
create table if not exists acceptances (
  email text not null, version text not null, accepted_at timestamptz not null default now(), primary key (email, version));`;

const who = () => process.env.GROVE_LEGAL_NAME;
const contact = () => process.env.GROVE_CONTACT_EMAIL;
export const termsOn = () => Boolean(who() && contact());

export async function agreed(pool: Pool, email: string) {
  if (!termsOn()) return true;
  const { rowCount } = await pool.query("select 1 from acceptances where email = $1 and version = $2", [email, TERMS_VERSION]);
  return Boolean(rowCount);
}

export const agree = (pool: Pool, email: string) =>
  pool.query("insert into acceptances (email, version) values ($1, $2) on conflict do nothing", [email, TERMS_VERSION]);

const head = (title: string) => `
  <h1>${title}</h1>
  ${termsOn() ? "" : `<p class="draft"><strong>Draft.</strong> This page is not final and nobody is asked to agree to it yet.</p>`}
  <p class="note">Version ${TERMS_VERSION}. Grove is run by ${who() ?? "its maker"}${contact() ? `. Contact: <a href="mailto:${contact()}">${contact()}</a>` : ""}.</p>`;

export const termsPage = () =>
  shell("Grove: terms", `${head("Terms")}
  <h2>What Grove is</h2>
  <p>Grove makes small apps that you use through your AI assistant. Grove keeps each app's code, runs it, and gives it its own database and address.</p>
  <h2>Your account</h2>
  <ul>
    <li>You must be 18 or over, and use your own email address.</li>
    <li>You are responsible for what is done with your account and with the apps you make.</li>
  </ul>
  <h2>Your apps and your information</h2>
  <ul>
    <li>The apps you make, their code and the information in them are yours. You can download an app's code and take a copy of its information at any time.</li>
    <li>You give Grove permission to store and run them, only so that Grove can provide the service.</li>
    <li>If your app holds information about other people, you are responsible for having the right to hold it and for telling those people.</li>
  </ul>
  <h2>What you must not do</h2>
  <ul>
    <li>Break the law, or help anyone else to.</li>
    <li>Send spam, run scams, or pretend to be a person or organisation you are not.</li>
    <li>Collect passwords, card numbers or other secrets from people under false pretences.</li>
    <li>Attack, overload or probe Grove, its apps or anyone else's systems, or use Grove to mine cryptocurrency.</li>
    <li>Store or share material that is illegal, or that sexualises children. We report the latter to the authorities.</li>
    <li>Get around the limits of your plan, for example by making several accounts.</li>
  </ul>
  <p>We may pause or remove an app, or close an account, that breaks these rules. Where we reasonably can, we tell you first and give you time to take your code and information.</p>
  <h2>Plans and payment</h2>
  <ul>
    <li>The free plan costs nothing. The paid plan is charged monthly in advance through Stripe, until you cancel.</li>
    <li>You can cancel at any time. The paid plan then runs to the end of the month you have paid for.</li>
    <li>If we change a price, we tell you at least 30 days before it applies to you.</li>
  </ul>
  <h2>How reliable Grove is</h2>
  <p>Grove is new. We work to keep it running and your information safe, but we do not promise it will always be available or free of mistakes. Keep your own copy of anything you cannot afford to lose. Apps are written with the help of AI and can be wrong: check what they do before you rely on them.</p>
  <h2>Our responsibility to you</h2>
  <p>Nothing here limits responsibility that the law does not let us limit. Otherwise, we are not responsible for losses we could not reasonably have foreseen, or for lost profit or business, and the most we will owe you is what you paid for Grove in the twelve months before the problem.</p>
  <h2>Ending</h2>
  <p>You can stop using Grove and delete your apps whenever you like. If we close Grove, we will give you at least 30 days to take your code and information.</p>
  <h2>Changes to these terms</h2>
  <p>If we change these terms in a way that matters, Grove will ask you to agree again before you make or change apps.</p>
  <h2>Law</h2>
  <p>These terms are under the law of England and Wales. If you use Grove as a consumer, you keep the protections of the law where you live.</p>
  <p><a href="/privacy">Privacy</a> · <a href="/">Back to Grove</a></p>`);

export const privacyPage = () =>
  shell("Grove: privacy", `${head("Privacy")}
  <h2>What we keep</h2>
  <ul>
    <li><strong>Your email address</strong>, to sign you in and to write to you about your apps.</li>
    <li><strong>Your apps</strong>: their code, their names and descriptions, and who you let use them.</li>
    <li><strong>What is in your apps</strong>: whatever you and the people you invite put there. Each app has its own database.</li>
    <li><strong>Your plan</strong>: whether you pay, and Stripe's reference for you. We never see or keep card numbers.</li>
    <li><strong>What you agreed to</strong>: the version of the terms and when.</li>
    <li><strong>Technical records</strong> of requests, kept for a short time to keep Grove working and safe.</li>
  </ul>
  <h2>What we do with it</h2>
  <p>We use it to provide Grove, to take payment, to keep Grove safe, and to tell you about things that affect your apps. We do not sell it, and we do not use what is in your apps for advertising or to train AI models. We only look inside an app when you ask us for help, when the law requires it, or to deal with a breach of the terms.</p>
  <p>Your AI assistant (such as Claude or ChatGPT) sees what passes between it and your apps. That is covered by your agreement with whoever provides the assistant, not by Grove.</p>
  <h2>Who helps us run Grove</h2>
  <ul>
    <li><strong>Neon</strong> keeps the databases, and runs Grove itself and apps that have a database of their own. Information is stored in the United States.</li>
    <li><strong>Google Cloud</strong> runs apps on the free plan and the sign-in for them, in the United States.</li>
    <li><strong>Stripe</strong> takes payments.</li>
    <li><strong>Postmark</strong> sends emails.</li>
    <li><strong>Cloudflare</strong> directs visitors to Grove and its apps.</li>
  </ul>
  <p>These companies handle information only to provide their service to us. Where information leaves the United Kingdom or Europe, it is covered by the safeguards the law requires.</p>
  <h2>How long we keep it</h2>
  <p>For as long as you have an account. When you delete an app, its database is deleted with it. When you ask us to close your account, we delete your apps and your details within 30 days, apart from payment records the law makes us keep.</p>
  <h2>Your rights</h2>
  <p>You can ask to see what we hold about you, have it corrected or deleted, or take a copy with you. ${contact() ? `Write to <a href="mailto:${contact()}">${contact()}</a>.` : ""} If you are unhappy with how we answer, you can complain to the Information Commissioner's Office in the United Kingdom, or to the regulator where you live.</p>
  <h2>Information about other people in your apps</h2>
  <p>For what you put in your apps about other people, you decide what is kept and why, and Grove only holds it for you. People who want that information corrected or removed should ask you, the app's maker.</p>
  <h2>Cookies</h2>
  <p>Grove uses only the cookies needed to keep you signed in. There is no advertising and no tracking.</p>
  <p><a href="/terms">Terms</a> · <a href="/">Back to Grove</a></p>`);
