// How Grove is doing, for its maker: who signs up, how far they get, and what went wrong. Read from
// Grove's own tables only; nothing is tracked on anyone's pages. Also the daily summary email.
import type { Pool } from "pg";

/** The funnel and the day's trouble, over the last `days` days. */
export async function stats(pool: Pool, days = 30) {
  const q = async (sql: string, args: unknown[] = [days]) => (await pool.query(sql, args)).rows;
  const [[people], [funnel], [apps], [trouble], top] = await Promise.all([
    q(`select count(*)::int total, count(*) filter (where added_at > now() - make_interval(days => $1))::int new,
         count(*) filter (where added_at > now() - interval '1 day')::int today from maple_people`),
    q(`with joined as (select email from maple_people where added_at > now() - make_interval(days => $1)),
         made as (select distinct m email from apps, unnest(makers) m where m in (select email from joined)),
         shipped as (select distinct v.author email from versions v where v.shipped_at is not null and v.message not like 'Start % from the MAPLE template' and v.author in (select email from joined)),
         back as (select distinct u.email from usage u join maple_people p on p.email = u.email where p.email in (select email from joined) and u.day >= (p.added_at::date + 7)),
         active as (select distinct email from usage where day > current_date - 7)
       select (select count(*) from joined)::int signed_up, (select count(*) from made)::int made_an_app,
         (select count(*) from shipped)::int shipped_a_change, (select count(*) from back)::int came_back_after_a_week,
         (select count(*) from active)::int active_this_week`),
    q(`select count(*)::int total, count(*) filter (where created_at > now() - make_interval(days => $1))::int new,
         count(*) filter (where host = 'runner')::int on_runner, count(*) filter (where paused_at is not null)::int paused,
         count(*) filter (where limited)::int limited,
         (select count(*) from plans where status in ('active', 'trialing'))::int paying,
         (select count(*) from versions where shipped_at > now() - make_interval(days => $1))::int ships
       from apps`),
    q(`select (select count(*) from reports where closed_at is null)::int open_reports,
         (select count(*) from reports where reporter = 'Grove check' and what like 'Ship %' and created_at > now() - interval '1 day')::int ships_stopped_today,
         (select count(*) from site_imports where status = 'failed' and updated_at > now() - interval '1 day')::int imports_failed_today,
         (select count(*) from site_imports where status = 'done' and updated_at > now() - interval '1 day')::int imports_done_today,
         (select count(*) from service_calls where service = 'email' and not mock and at > now() - interval '1 day')::int emails_today`, []),
    q(`select a.slug, a.title, a.makers[1] maker, sum(u.calls)::int calls from usage u join apps a on a.slug = u.app
       where u.day > current_date - 7 group by a.slug, a.title, a.makers[1] order by calls desc limit 5`, []),
  ]);
  return { days, people, funnel, apps, trouble, busiestThisWeek: top };
}

/** The daily email to Grove's makers, in plain words. */
export function digest(s: Awaited<ReturnType<typeof stats>>, site: string) {
  const f = s.funnel, t = s.trouble;
  const pct = (n: number) => (f.signed_up ? ` (${Math.round((100 * n) / f.signed_up)}%)` : "");
  return `Grove today

People: ${s.people.total} in all, ${s.people.today} new today, ${s.people.new} in the last ${s.days} days.

Of the ${f.signed_up} who joined in the last ${s.days} days:
  made an app: ${f.made_an_app}${pct(f.made_an_app)}
  shipped a change of their own: ${f.shipped_a_change}${pct(f.shipped_a_change)}
  came back after their first week: ${f.came_back_after_a_week}${pct(f.came_back_after_a_week)}
Active this week: ${f.active_this_week}

Apps: ${s.apps.total} (${s.apps.new} new), ${s.apps.on_runner} on the shared runner, ${s.apps.limited} from new accounts, ${s.apps.paused} paused. Paying: ${s.apps.paying}. Ships in ${s.days} days: ${s.apps.ships}.

Needs a look:
  open reports: ${t.open_reports}
  ships stopped by the checks today: ${t.ships_stopped_today}
  imports failed today: ${t.imports_failed_today} (${t.imports_done_today} worked)
  emails sent by apps today: ${t.emails_today}
${s.busiestThisWeek.length ? `\nBusiest apps this week:\n${s.busiestThisWeek.map((a: any) => `  ${a.title} (${a.slug}, ${a.maker}): ${a.calls} calls`).join("\n")}\n` : ""}
list_reports in Grove shows the reports. ${site}`;
}
