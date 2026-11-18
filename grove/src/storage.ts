// Where Grove keeps the files apps ask it to keep: any S3-compatible store. On Neon the bucket in
// neon.ts gives the AWS_* settings automatically; elsewhere set the same four names for R2, GCS or S3.
// Only three calls are needed, so they are signed here rather than carrying a whole SDK.
import { createHash, createHmac } from "node:crypto";

const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Uint8Array, data: string) => createHmac("sha256", key).update(data).digest();

export const BUCKET = () => process.env.FILES_BUCKET ?? "files";
export const storageOn = () => Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_ENDPOINT_URL_S3);

/** The headers that sign one S3 request (SigV4, path-style). */
export function signed(method: string, url: URL, body: Uint8Array | undefined, extra: Record<string, string>, now = new Date(), env = process.env): Record<string, string> {
  const region = env.AWS_REGION ?? "auto";
  const stamp = now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = stamp.slice(0, 8);
  const payload = sha(body ?? "");
  const headers: Record<string, string> = { ...extra, host: url.host, "x-amz-content-sha256": payload, "x-amz-date": stamp };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim()]));
  const path = url.pathname.split("/").map((p) => encodeURIComponent(decodeURIComponent(p)).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
  const request = [method, path, "", ...names.map((n) => `${n}:${lower[n]}`), "", names.join(";"), payload].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha(request)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${env.AWS_SECRET_ACCESS_KEY}`, day), region), "s3"), "aws4_request");
  const { host: _host, ...send } = headers;
  return { ...send, authorization: `AWS4-HMAC-SHA256 Credential=${env.AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${names.join(";")}, Signature=${hmac(key, toSign).toString("hex")}` };
}

const at = (key: string) => new URL(`${process.env.AWS_ENDPOINT_URL_S3!.replace(/\/$/, "")}/${BUCKET()}/${key}`);

export async function putObject(key: string, body: Uint8Array, type: string) {
  const url = at(key);
  const res = await fetch(url, { method: "PUT", headers: signed("PUT", url, body, { "content-type": type }), body: body as unknown as BodyInit });
  if (!res.ok) throw new Error(`Storing the file failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

/** The stored file, to pass straight on. Undefined if it isn't there. */
export async function getObject(key: string) {
  const url = at(key);
  const res = await fetch(url, { headers: signed("GET", url, undefined, {}) });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`Reading the file failed: ${res.status}`);
  return res;
}

export async function deleteObject(key: string) {
  const url = at(key);
  const res = await fetch(url, { method: "DELETE", headers: signed("DELETE", url, undefined, {}) });
  if (!res.ok && res.status !== 404) throw new Error(`Removing the file failed: ${res.status}`);
}
