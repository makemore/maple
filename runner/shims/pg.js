// Stands in for the "pg" package inside the sandbox. The app has no database password and opens no
// connection: each query is handed to the runner, which runs it as this app's own limited login.
// Results come back as JSON, so dates and raw bytes are turned back into what "pg" gives.
const revive = (value, type) => {
  if (value == null) return value;
  if (type === 17) return Buffer.from(value, "base64");
  if (Array.isArray(value)) return value.map((v) => (v == null ? v : new Date(v)));
  return new Date(value);
};

export class Pool {
  constructor() {}
  on() {}
  async query(text, values = []) {
    if (text && typeof text === "object") ({ text, values = [] } = text);
    const res = await fetch("http://db.runner/query", { method: "POST", body: JSON.stringify({ text, values }) });
    const out = await res.json();
    if (!res.ok) throw Object.assign(new Error(out.error), { code: out.code });
    if (out.types) for (const row of out.rows) for (const [name, type] of Object.entries(out.types)) row[name] = revive(row[name], type);
    return { rows: out.rows, rowCount: out.rowCount };
  }
  async end() {}
}
export const Client = Pool;
export default { Pool, Client };
