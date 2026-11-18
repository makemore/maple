// Stands in for the "pg" package inside the sandbox. The app has no database password and opens no
// connection: each query is handed to the runner, which runs it as this app's own limited login.
export class Pool {
  constructor() {}
  on() {}
  async query(text, values = []) {
    const res = await fetch("http://db.runner/query", { method: "POST", body: JSON.stringify({ text, values }) });
    const out = await res.json();
    if (!res.ok) throw Object.assign(new Error(out.error), { code: out.code });
    return out;
  }
  async end() {}
}
export const Client = Pool;
export default { Pool, Client };
