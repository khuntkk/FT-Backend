-- Payroll inputs: what a month's pay is worked out from.
--
-- The arithmetic itself (day rate, cut for absence, rounding to the paisa,
-- recovering only what the packet allows) is the API's, ported from
-- calculateSalary() in sf_core with its tests as fixtures. What it needs to
-- know is gathered here, in one query per month rather than four round
-- trips per person.

-- What a person still owes in advances going into a month's payslip.
--
-- Everything given before the month ends, less what the *paid* payslips of
-- earlier months recovered. Derived, never a running total: deleting or
-- restoring a payslip puts the balance right by itself. Null bounds mean
-- "now, after every payslip".
create or replace function fn_advance_outstanding(
  p_staff_id bigint,
  p_period_start date default null,
  p_period_end date default null
) returns numeric(12,2)
language sql stable as $$
  select greatest(0,
    coalesce((
      select sum(a.amount) from advances a
      where a.staff_id = p_staff_id
        and a.deleted_at is null
        and (p_period_end is null or a.given_on < p_period_end)), 0)
    -
    coalesce((
      select sum(p.advance_deducted) from salary_payments p
      where p.staff_id = p_staff_id
        and p.deleted_at is null
        and p.status = 'paid'
        and (p_period_start is null or p.period_start < p_period_start)), 0)
  )::numeric(12,2)
$$;

-- Everything the salary screen needs for one property and month, one row
-- per active person.
--
--   days_worked         attendance credited, half days as 0.5
--   every_day_present   every date of the month a full present day — what
--                       earns the no-leave bonus
--   bonus_earned        each entry's bonus divided by how many ran it
--   stitches            the entries' stitch counts
--   advance_outstanding owed going into this month (fn_advance_outstanding)
--   advance_given       handed out during the month
--   payment_id          the month's live payslip, if there is one — a paid
--                       month is shown from it, never recomputed
create or replace function fn_payroll_inputs(p_property_id bigint, p_month date)
returns table (
  staff_id             bigint,
  days_worked          numeric(5,1),
  every_day_present    boolean,
  bonus_earned         numeric(12,2),
  stitches             bigint,
  advance_outstanding  numeric(12,2),
  advance_given        numeric(12,2),
  payment_id           bigint
)
language sql stable as $$
  with bounds as (
    select date_trunc('month', p_month)::date as start_on,
           (date_trunc('month', p_month) + interval '1 month')::date as end_on
  ),
  people as (
    select s.id
    from staff s
    where s.property_id = p_property_id
      and s.deleted_at is null
      and s.is_active
  ),
  days as (
    select d.staff_id,
           sum(d.day_value)::numeric(5,1) as days_worked,
           count(*) filter (where d.status = 'present') as present_days
    from vw_attendance_days d, bounds b
    where d.property_id = p_property_id
      and d.work_date >= b.start_on and d.work_date < b.end_on
    group by d.staff_id
  ),
  crews as (
    select ek.entry_id, count(*) as size
    from entry_karigars ek
    join production_entries pe on pe.id = ek.entry_id, bounds b
    where pe.property_id = p_property_id
      and pe.deleted_at is null
      and pe.work_date >= b.start_on and pe.work_date < b.end_on
    group by ek.entry_id
  ),
  earned as (
    select ek.staff_id,
           round(sum(pe.bonus_amount / c.size), 2) as bonus_earned,
           sum(pe.total_stitches)::bigint as stitches
    from entry_karigars ek
    join production_entries pe on pe.id = ek.entry_id
    join crews c on c.entry_id = ek.entry_id
    group by ek.staff_id
  ),
  given as (
    select a.staff_id, sum(a.amount)::numeric(12,2) as advance_given
    from advances a, bounds b
    where a.property_id = p_property_id
      and a.deleted_at is null
      and a.given_on >= b.start_on and a.given_on < b.end_on
    group by a.staff_id
  )
  select
    p.id,
    coalesce(d.days_worked, 0),
    coalesce(d.present_days, 0) = (b.end_on - b.start_on),
    coalesce(e.bonus_earned, 0),
    coalesce(e.stitches, 0),
    fn_advance_outstanding(p.id, b.start_on, b.end_on),
    coalesce(g.advance_given, 0),
    (select sp.id from salary_payments sp
     where sp.staff_id = p.id and sp.period_start = b.start_on and sp.deleted_at is null)
  from people p
  cross join bounds b
  left join days d on d.staff_id = p.id
  left join earned e on e.staff_id = p.id
  left join given g on g.staff_id = p.id
  order by p.id
$$;
