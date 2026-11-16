// GitHub, as Grove's GitHub App. The App's key stays here; apps and assistants never see it.
import { createPrivateKey } from "node:crypto";
import { SignJWT } from "jose";
import nacl from "tweetnacl";
import blake from "blakejs";

const API = "https://api.github.com";
export const ORG = process.env.GITHUB_ORG ?? "";

let installation: { id: number } | undefined;
let cached: { token: string; until: number } | undefined;

async function appJwt() {
  const key = createPrivateKey((process.env.GITHUB_APP_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"));
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({}).setProtectedHeader({ alg: "RS256" }).setIssuer(process.env.GITHUB_APP_ID ?? "").setIssuedAt(now - 60).setExpirationTime(now + 540).sign(key);
}

async function token() {
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const jwt = await appJwt();
  const h = { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json" };
  installation ??= await (await fetch(`${API}/orgs/${ORG}/installation`, { headers: h })).json();
  if (!installation?.id) throw new Error(`Grove's GitHub App is not installed on ${ORG}.`);
  const res = await fetch(`${API}/app/installations/${installation.id}/access_tokens`, { method: "POST", headers: h });
  if (!res.ok) throw new Error(`GitHub token: ${res.status} ${await res.text()}`);
  const t = await res.json();
  cached = { token: t.token, until: Date.parse(t.expires_at) };
  return t.token as string;
}

export class GitHubError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function gh<T = any>(method: string, path: string, body?: unknown, accept = "application/vnd.github+json"): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${await token()}`, accept, "x-github-api-version": "2022-11-28", ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new GitHubError(res.status, `GitHub ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  if (res.status === 204) return undefined as T;
  return (accept.includes("raw") ? res.text() : res.json()) as Promise<T>;
}

/** Text of a file at a ref, or null if it doesn't exist. */
export async function readFile(repo: string, path: string, ref: string) {
  try {
    return await gh<string>("GET", `/repos/${ORG}/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`, undefined, "application/vnd.github.raw+json");
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return null;
    throw e;
  }
}

/** One commit on a branch with these files set (content) or deleted (null). Creates the branch from main if needed. */
export async function commitFiles(repo: string, branch: string, files: { path: string; content: string | null }[], message: string, from = "main") {
  const r = `/repos/${ORG}/${repo}`;
  let head: string;
  try {
    head = (await gh("GET", `${r}/git/ref/heads/${branch}`)).object.sha;
  } catch (e) {
    if (!(e instanceof GitHubError && e.status === 404)) throw e;
    head = (await gh("GET", `${r}/git/ref/heads/${from}`)).object.sha;
    await gh("POST", `${r}/git/refs`, { ref: `refs/heads/${branch}`, sha: head });
  }
  const base = (await gh("GET", `${r}/git/commits/${head}`)).tree.sha;
  const tree = await gh("POST", `${r}/git/trees`, {
    base_tree: base,
    tree: files.map((f) => (f.content === null ? { path: f.path, mode: "100644", type: "blob", sha: null } : { path: f.path, mode: "100644", type: "blob", content: f.content })),
  });
  const commit = await gh("POST", `${r}/git/commits`, { message, tree: tree.sha, parents: [head] });
  await gh("PATCH", `${r}/git/refs/heads/${branch}`, { sha: commit.sha });
  return commit.sha as string;
}

/** Sets a GitHub Actions secret, sealed with the repository's public key as GitHub requires. */
export async function setSecret(repo: string, name: string, value: string) {
  const r = `/repos/${ORG}/${repo}/actions/secrets`;
  const { key, key_id } = await gh("GET", `${r}/public-key`);
  const pk = Buffer.from(key, "base64");
  const eph = nacl.box.keyPair();
  const nonce = blake.blake2b(Buffer.concat([eph.publicKey, pk]), undefined, 24);
  const boxed = nacl.box(Buffer.from(value), nonce, pk, eph.secretKey);
  const sealed = Buffer.concat([eph.publicKey, boxed]).toString("base64");
  await gh("PUT", `${r}/${name}`, { encrypted_value: sealed, key_id });
}

export async function setVariable(repo: string, name: string, value: string) {
  const r = `/repos/${ORG}/${repo}/actions/variables`;
  try {
    await gh("POST", r, { name, value });
  } catch (e) {
    if (!(e instanceof GitHubError && e.status === 409)) throw e;
    await gh("PATCH", `${r}/${name}`, { name, value });
  }
}

/** The maple/deploy status for a ref: pending, success or failure, and the app or run address. */
export async function deployStatus(repo: string, ref: string) {
  const s = await gh("GET", `/repos/${ORG}/${repo}/commits/${encodeURIComponent(ref)}/status`);
  const d = s.statuses.find((x: any) => x.context === "maple/deploy");
  return { sha: s.sha as string, state: (d?.state ?? "waiting") as string, url: d?.target_url as string | undefined, description: d?.description as string | undefined };
}

/** The end of the failing step's log for the latest run on a branch, so an assistant can fix it. */
export async function failureLog(repo: string, branch: string) {
  const runs = await gh("GET", `/repos/${ORG}/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=1`);
  const run = runs.workflow_runs[0];
  if (!run) return null;
  const { jobs } = await gh("GET", `/repos/${ORG}/${repo}/actions/runs/${run.id}/jobs`);
  const job = jobs.find((j: any) => j.conclusion === "failure");
  if (!job) return { run: run.html_url, status: run.status, conclusion: run.conclusion };
  const step = job.steps.find((s: any) => s.conclusion === "failure");
  const res = await fetch(`${API}/repos/${ORG}/${repo}/actions/jobs/${job.id}/logs`, { headers: { authorization: `Bearer ${await token()}` } });
  const lines = res.ok ? (await res.text()).split("\n") : [];
  return { run: run.html_url, failedStep: step?.name, log: lines.slice(-120).map((l) => l.replace(/^\S+Z /, "")).join("\n") };
}
