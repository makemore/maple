// Neon, with Grove's organization API key: one project per app, and a deploy key limited to it.
const API = "https://console.neon.tech/api/v2";

async function neon<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${process.env.NEON_API_KEY}`, accept: "application/json", ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Neon ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<T>;
}

export async function createProject(name: string) {
  const { project } = await neon("POST", "/projects", {
    project: { name, org_id: process.env.NEON_ORG_ID, region_id: process.env.NEON_REGION ?? "aws-us-east-2", pg_version: 17, branch: { name: "production" } },
  });
  return project.id as string;
}

/** An API key that can only reach this one project: it goes to the app's GitHub Actions to deploy. */
export async function projectKey(projectId: string, name: string) {
  const k = await neon("POST", `/organizations/${process.env.NEON_ORG_ID}/api_keys`, { key_name: name, project_id: projectId });
  return k.key as string;
}

export const deleteProject = (projectId: string) => neon("DELETE", `/projects/${projectId}`);
