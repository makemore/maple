// Housekeeping Grove does on its own, about once an hour, so its database doesn't grow for ever.
import type { Pool } from "pg";

export const UPKEEP_SCHEMA = `
create table if not exists upkeep (job text primary key, at timestamptz not null default now());`;

/** How many shipped versions of each app are kept to go back to. The live one and any open change's are always kept. */
export const KEEP_SHIPPED = 10;

/** True at most once per `every` for a job, however many copies of Grove ask at the same moment. */
export async function due(pool: Pool, job: string, every = "1 hour") {
  const { rowCount } = await pool.query(
    "insert into upkeep (job) values ($1) on conflict (job) do update set at = now() where upkeep.at < now() - $2::interval",
    [job, every],
  );
  return Boolean(rowCount);
}

/**
 * Removes saved code nobody can reach any more: saves that were never shipped and belong to no open
 * change (after two days), and shipped versions older than the last ten. Also old service records.
 */
export async function prune(pool: Pool) {
  const versions = await pool.query(
    `delete from versions v where
       not exists (select 1 from apps a where a.live = v.id)
       and not exists (select 1 from changes c where c.app = v.app and (c.version = v.id or c.base = v.id))
       and ((v.shipped_at is null and v.created_at < now() - interval '2 days')
         or (v.shipped_at is not null and v.id not in (
              select k.id from versions k where k.app = v.app and k.shipped_at is not null order by k.shipped_at desc, k.id desc limit $1)))`,
    [KEEP_SHIPPED],
  );
  const calls = await pool.query("delete from service_calls where at < now() - interval '30 days'");
  const pays = await pool.query("delete from pretend_payments where created_at < now() - interval '30 days'");
  const offers = await pool.query("delete from app_offers where at < now() - interval '14 days'");
  return { versions: versions.rowCount ?? 0, serviceCalls: calls.rowCount ?? 0, pretendPayments: pays.rowCount ?? 0, offers: offers.rowCount ?? 0 };
}
