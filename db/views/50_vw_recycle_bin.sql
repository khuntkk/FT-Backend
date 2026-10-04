-- The recycle bin: everything deleted within the last seven days.
--
-- One row per recoverable item, in the shape the apps' DeletedItem expects
-- (repositories.dart): the facts, not sentences, so the screen words them in
-- its own language. kind uses DeletedKind's names.
--
--   * Folding compares batches with coalesce(…, false): with a live parent
--     its batch is null, the comparison is null, and a bare `not (…)` would
--     drop a child deleted on its own from the bin altogether.
--   * A child removed *by* its parent's deletion — a machine's slips, a
--     person's advances and payslips — shares the parent's deleted_batch and
--     is folded into the parent's row (child_count) rather than listed twice.
--   * A cleared month of attendance is one item, however many days it held.
--   * A day tapped back to unmarked is an edit, has no batch, and is not here.
--   * A person kept only so their slips keep their name has deleted_at pushed
--     past the window, so they are not here either.

create or replace function fn_recovery_window() returns interval
language sql immutable as $$ select interval '7 days' $$;

create or replace view vw_recycle_bin with (security_invoker = true) as
with window_start as (select now() - fn_recovery_window() as since)

select 'machine'::text as kind, m.property_id, m.id, m.deleted_at, m.deleted_batch,
       m.name, m.number as machine_number,
       null::text as category, null::text as code, null::date as on_date,
       null::text as shift_name, null::bigint as stitches, null::text as pay_mode,
       null::text as condition, null::text as bonus_kind, null::numeric(12,2) as amount,
       (select count(*) from production_entries e
        where e.machine_id = m.id and e.deleted_batch = m.deleted_batch)::int as child_count
from machines m, window_start w
where m.deleted_at > w.since

union all
select 'staff', s.property_id, s.id, s.deleted_at, s.deleted_batch,
       s.name, null, s.category, s.code, null, null, null, null, null, null, null,
       ((select count(*) from advances a
         where a.staff_id = s.id and a.deleted_batch = s.deleted_batch)
      + (select count(*) from salary_payments p
         where p.staff_id = s.id and p.deleted_batch = s.deleted_batch))::int
from staff s, window_start w
where s.deleted_at > w.since

union all
select 'productionEntry', e.property_id, e.id, e.deleted_at, e.deleted_batch,
       mc.name, mc.number, null, null, e.work_date, sh.name, e.total_stitches,
       null, null, null, null, 0
from production_entries e
join machines mc on mc.id = e.machine_id
join shifts sh on sh.id = e.shift_id, window_start w
where e.deleted_at > w.since
  and not coalesce(e.deleted_batch = mc.deleted_batch, false)

union all
select 'upad', a.property_id, a.id, a.deleted_at, a.deleted_batch,
       s.name, null, null, null, a.given_on, null, null, a.mode, null, null, a.amount, 0
from advances a
join staff s on s.id = a.staff_id, window_start w
where a.deleted_at > w.since
  and not coalesce(a.deleted_batch = s.deleted_batch, false)

union all
select 'salaryPayment', p.property_id, p.id, p.deleted_at, p.deleted_batch,
       s.name, null, null, null, p.period_start, null, null, null, null, null,
       p.net_payable, 0
from salary_payments p
join staff s on s.id = p.staff_id, window_start w
where p.deleted_at > w.since
  and not coalesce(p.deleted_batch = s.deleted_batch, false)

union all
select 'bonusRule', r.property_id, r.id, r.deleted_at, r.deleted_batch,
       r.name, null, null, null, null, null, null, null, r.condition, r.kind, null, 0
from bonus_rules r, window_start w
where r.deleted_at > w.since

union all
-- The lowest id stands for the batch, as it does in the apps.
select 'attendance', k.property_id, min(k.id), max(k.deleted_at), k.deleted_batch,
       s.name, null, null, null, date_trunc('month', min(k.work_date))::date,
       null, null, null, null, null, null, count(*)::int
from attendance_marks k
join staff s on s.id = k.staff_id, window_start w
where k.deleted_at > w.since
  and k.deleted_batch is not null
group by k.property_id, k.deleted_batch, s.name;
