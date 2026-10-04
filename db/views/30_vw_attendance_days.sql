-- Attendance (hajari) as it resolves, one row per person per day that has any.
--
-- Attendance is derived, not only stored — the rule the whole pay model rests
-- on (HANDOVER.md §7, and LocalHajariRepository in sf_core):
--   1. a mark made by hand wins, whatever production says;
--   2. otherwise, being on a live production entry that date makes a person
--      present — half a day only if *every* such entry flags them half;
--   3. a stitch-based ("second machine") entry never counts;
--   4. anything else is unmarked, and has no row here.
-- Pay counts present as 1, half day as 0.5, absent as 0.

create or replace view vw_attendance_days with (security_invoker = true) as
with worked as (
  select
    ek.property_id,
    ek.staff_id,
    pe.work_date,
    bool_and(ek.is_half_day) as every_entry_half
  from entry_karigars ek
  join production_entries pe on pe.id = ek.entry_id
  where pe.deleted_at is null
    and not pe.is_stitch_based
  group by ek.property_id, ek.staff_id, pe.work_date
),
marked as (
  select property_id, staff_id, work_date, status
  from attendance_marks
  where deleted_at is null
),
resolved as (
  select
    coalesce(k.property_id, w.property_id) as property_id,
    coalesce(k.staff_id, w.staff_id)       as staff_id,
    coalesce(k.work_date, w.work_date)     as work_date,
    coalesce(
      k.status,
      case when w.every_entry_half then 'halfDay' else 'present' end
    )                                      as status,
    (k.status is null)                     as from_production
  from marked k
  full join worked w
    on w.property_id = k.property_id
   and w.staff_id = k.staff_id
   and w.work_date = k.work_date
)
select
  property_id,
  staff_id,
  work_date,
  status,
  from_production,
  (case status when 'present' then 1.0 when 'halfDay' then 0.5 else 0 end)::numeric(2,1)
    as day_value
from resolved;
