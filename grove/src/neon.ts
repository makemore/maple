// Neon, with Grove's organization API key: one project per app, a database branch per preview,
// sign-in for each address, and the app's own address on the apps domain.
const API = "https://console.neon.tech/api/v2";

export class NeonError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function neon<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${process.env.NEON_API_KEY}`, accept: "application/json", ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new NeonError(res.status, `Neon ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Neon refuses a second change to a project while the first is still being applied; wait and try again. */
async function settled<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (!(e instanceof NeonError) || e.status !== 423 || i >= 20) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

const already = (e: unknown) => {
  if (e instanceof NeonError && (e.status === 409 || /already/i.test(e.message))) return;
  throw e;
};

/** A new project with sign-in switched on. Returns its id and the id of its live database branch. */
export async function createProject(name: string) {
  const { project, branch } = await neon("POST", "/projects", {
    project: { name, org_id: process.env.NEON_ORG_ID, region_id: process.env.NEON_REGION ?? "aws-us-east-2", pg_version: 17, branch: { name: "production" } },
  });
  await settled(() => neon("POST", `/projects/${project.id}/branches/${branch.id}/auth`, { auth_provider: "better_auth" })).catch(already);
  return { project: project.id as string, branch: branch.id as string };
}

/** A copy of the live database for a preview. Sign-in settings come along with it. */
export async function createBranch(project: string, name: string, parent: string) {
  const { branch } = await settled(() => neon("POST", `/projects/${project}/branches`, { branch: { name, parent_id: parent }, endpoints: [{ type: "read_write" }] }));
  return branch.id as string;
}

export const deleteBranch = (project: string, branch: string) =>
  settled(() => neon("DELETE", `/projects/${project}/branches/${branch}`)).catch((e) => {
    if (!(e instanceof NeonError) || e.status !== 404) throw e;
  });

/** Lets people sign in at this address, and lets assistants connect to its /mcp. */
export async function setUpSignIn(project: string, branch: string, url: string, sender?: { name: string; email: string }) {
  const base = `/projects/${project}/branches/${branch}/auth`;
  // Sign-in codes come from Grove's own address rather than Neon's shared one, which is rate-limited.
  // If this fails the app still signs people in, through the shared sender.
  if (sender && process.env.POSTMARK_TOKEN)
    await neon("PATCH", `${base}/email_provider`, { type: "standard", host: "smtp.postmarkapp.com", port: 587, username: process.env.POSTMARK_TOKEN, password: process.env.POSTMARK_TOKEN, sender_email: sender.email, sender_name: sender.name }).catch((e: Error) =>
      console.error("sign-in sender not set:", e.message),
    );
  await settled(() => neon("POST", `${base}/domains`, { domain: url, auth_provider: "better_auth" })).catch(already);
  await settled(() => neon("PATCH", `${base}/plugins/oauth-provider`, { enabled: true, login_page: `${url}/auth/sign-in`, consent_page: `${url}/auth/consent`, resources: [{ identifier: `${url}/mcp` }] }));
}

/** Serves the app's function at a name on the apps domain (its DNS already points every name at Neon). */
export const registerDomain = (project: string, branch: string, domain: string, slug = "app") =>
  settled(() => neon("POST", `/projects/${project}/branches/${branch}/custom-domains`, { domain, entity_type: "function", entity_id: slug }));

/** The connection string for an app's live database, for its maker to take a copy of the data. */
export async function connectionUri(project: string, branch: string) {
  const [{ databases }, { roles }] = await Promise.all([neon("GET", `/projects/${project}/branches/${branch}/databases`), neon("GET", `/projects/${project}/branches/${branch}/roles`)]);
  const role = roles.find((r: any) => !r.protected && r.name !== "authenticator" && r.name !== "anonymous" && r.name !== "authenticated") ?? roles[0];
  const db = databases.find((d: any) => d.owner_name === role.name) ?? databases[0];
  const { uri } = await neon("GET", `/projects/${project}/connection_uri?branch_id=${branch}&database_name=${encodeURIComponent(db.name)}&role_name=${encodeURIComponent(role.name)}`);
  return uri as string;
}

export const deleteProject = (project: string) => neon("DELETE", `/projects/${project}`);
