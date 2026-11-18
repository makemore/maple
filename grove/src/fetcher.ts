// Fetching other people's websites for an import, carefully: only public addresses (never Grove's own
// network or a cloud's metadata service), every redirect checked again, a size cap on what comes back,
// a timeout, and robots.txt respected unless the person has shown the site is theirs.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const AGENT = "GroveImporter/1.0 (+https://makewithgrove.com/#move)";

/** True for addresses that only make sense inside a network: loopback, private ranges, link-local, metadata. */
export function privateAddress(ip: string) {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return privateAddress(v.slice(7));
    return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith("64:ff9b:") || v.startsWith("2001:db8");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

export class FetchRefused extends Error {}

/** Tests serve sites from this machine; nothing else turns this on. */
let localOk = false;
export const allowLocalForTests = (on = true) => void (localOk = on);

/** Throws unless the URL is an ordinary public web address. */
export async function publicUrl(raw: string | URL, resolve = lookup) {
  const url = new URL(raw);
  if (localOk && /^(127\.0\.0\.1|localhost)$/.test(url.hostname)) return url;
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new FetchRefused(`Only web addresses can be imported, not ${url.protocol}`);
  if (url.username || url.password) throw new FetchRefused("Leave names and passwords out of the address.");
  if (url.port && !["80", "443"].includes(url.port)) throw new FetchRefused("Only sites on the usual web ports can be imported.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) throw new FetchRefused(`${host} isn't a public website.`);
  const ips = isIP(host) ? [{ address: host }] : await resolve(host, { all: true }).catch(() => []);
  if (!ips.length) throw new FetchRefused(`${host} couldn't be found. Check the address.`);
  if (ips.some((i) => privateAddress(i.address))) throw new FetchRefused(`${host} isn't a public website.`);
  return url;
}

export type Got = { url: string; status: number; type: string; body: Uint8Array; text: () => string };

/** One GET, following up to 5 redirects, each checked. Throws FetchRefused for addresses it won't visit. */
export async function get(raw: string, o: { maxBytes?: number; timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<Got> {
  const max = o.maxBytes ?? 3_000_000;
  let url = await publicUrl(raw);
  for (let hop = 0; hop < 6; hop++) {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(o.timeoutMs ?? 15_000), headers: { "user-agent": AGENT, accept: "*/*", ...o.headers } });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel();
      url = await publicUrl(new URL(res.headers.get("location")!, url));
      continue;
    }
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > max) {
      await res.body?.cancel();
      throw new FetchRefused(`${url.href} is too big to import (${Math.round(length / 1_000_000)} MB).`);
    }
    const chunks: Uint8Array[] = [];
    let n = 0;
    const reader = res.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > max) {
        await reader.cancel();
        throw new FetchRefused(`${url.href} is too big to import.`);
      }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks);
    return { url: url.href, status: res.status, type: (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase(), body, text: () => body.toString("utf8") };
  }
  throw new FetchRefused(`${raw} redirects too many times.`);
}

/** The paths robots.txt asks every robot (or ours) to stay out of. */
export function disallowed(robots: string) {
  const rules: string[] = [];
  let applies = false, inGroup = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [, key, value] = m;
    if (key.toLowerCase() === "user-agent") {
      if (!inGroup) applies = false;
      inGroup = true;
      if (value === "*" || /groveimporter/i.test(value)) applies = true;
    } else {
      inGroup = false;
      if (applies && key.toLowerCase() === "disallow" && value) rules.push(value);
    }
  }
  return rules;
}

export const blockedBy = (rules: string[], path: string) =>
  rules.some((r) => {
    const re = new RegExp("^" + r.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    return re.test(path);
  });

/** Runs jobs a few at a time. */
export async function eachLimited<T>(items: T[], limit: number, job: (item: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await job(items[i], i);
    }
  }));
}
