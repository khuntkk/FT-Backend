-- 0002 · Domain: what a unit records.
--
-- Mirrors the apps' Drift schema (packages/sf_core/lib/src/db/tables.dart,
-- schema v9) with the rules the apps learned the hard way enforced here too.
-- HANDOVER.md §7 walks through each table against its client counterpart.
--
-- Every table below carries:
--   property_id                 the tenant (row-level security keys on it)
--   created_at / updated_at     instants; updated_at kept by trigger
--   created_by_member_id …      who, for the audit trail
-- and the recoverable ones also carry:
--   deleted_at                  soft delete: hidden everywhere, kept 7 days
--   deleted_batch               ties rows removed in one action, so restoring
--                               the parent brings back exactly its children

-- ---------------------------------------------------------------------------
-- Machines
-- ---------------------------------------------------------------------------

create table machines (
  id                    bigint generated always as identity primary key,
  property_id           bigint not null references properties (id) on delete cascade,
  -- The painted number. Unique among live machines only (index below): a
  -- machine in the recycle bin must not stop a new one taking its number.
  number                integer not null check (number between 1 and 9999),
  name                  text check (length(name) <= 60),
  is_active             boolean not null default true,
  photo_file_id         uuid,
  model                 text check (length(model) <= 80),
  heads                 smallint check (heads between 1 and 100),
  needles               smallint check (needles between 1 and 30),
  location              text check (length(location) <= 80),
  serial_no             text check (length(serial_no) <= 80),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by_member_id  bigint,
  updated_by_member_id  bigint,
  deleted_at            timestamptz,
  deleted_by_member_id  bigint,
  deleted_batch         uuid,
  unique (property_id, id),
  foreign key (property_id, photo_file_id) references files (property_id, id)
    on delete set null (photo_file_id)
);
create unique index machines_live_number
  on machines (property_id, number) where deleted_at is null;
create trigger machines_touch before update on machines
  for each row execute function fn_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Staff (the roster: operators, supervisors, designers, other staff)
-- ---------------------------------------------------------------------------

create table staff (
  id                          bigint generated always as identity primary key,
  property_id                 bigint not null references properties (id) on delete cascade,
  code                        text check (length(code) <= 20),
  name                        text not null check (length(btrim(name)) between 1 and 80),
  phone                       text check (length(phone) <= 20),
  -- 'karigar' is shown as Operator; the trade word is what the schema was
  -- built on and renaming it would be a migration for nothing.
  category                    text not null default 'karigar'
                              check (category in ('karigar', 'supervisor', 'designer', 'otherStaff')),
  subcategory                 text check (length(subcategory) <= 40),
  monthly_salary              numeric(12,2) not null default 0 check (monthly_salary >= 0),
  -- Salary is divided by this for a day rate: 30 in the trade.
  pay_days_per_month          smallint not null default 30 check (pay_days_per_month between 1 and 31),
  cut_salary_for_absent_days  boolean not null default true,
  allow_half_day              boolean not null default true,
  joined_on                   date,
  left_on                     date,
  is_active                   boolean not null default true,
  notes                       text,
  photo_file_id               uuid,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  created_by_member_id        bigint,
  updated_by_member_id        bigint,
  deleted_at                  timestamptz,
  deleted_by_member_id        bigint,
  deleted_batch               uuid,
  unique (property_id, id),
  check (left_on is null or joined_on is null or left_on >= joined_on),
  foreign key (property_id, photo_file_id) references files (property_id, id)
    on delete set null (photo_file_id)
);
-- The comment on the client column said "unique when set" and nothing
-- enforced it. Here it is enforced, among live rows.
create unique index staff_live_code
  on staff (property_id, code) where deleted_at is null and code is not null;
create index staff_live_by_name on staff (property_id, name) where deleted_at is null;
create trigger staff_touch before update on staff
  for each row execute function fn_touch_updated_at();

-- A login that is also on the roster.
alter table property_members
  add foreign key (property_id, staff_id) references staff (property_id, id)
    on delete set null (staff_id);

-- ---------------------------------------------------------------------------
-- Shifts — versioned, never re-timed in place
-- ---------------------------------------------------------------------------

-- Editing a shift closes the version in effect on a date and opens a new one
-- from it, so a past slip always reads back with the hours it ran under.
-- lineage_id ties the versions of one shift together. Shifts are retired,
-- not deleted, so there is no deleted_at.
create table shifts (
  id                    bigint generated always as identity primary key,
  property_id           bigint not null references properties (id) on delete cascade,
  -- Equal to id for a first version; the trigger below fills it in.
  lineage_id            bigint not null,
  name                  text not null check (length(btrim(name)) between 1 and 30),
  start_minute          smallint not null check (start_minute between 0 and 1439),
  duration_minutes      smallint not null check (duration_minutes between 1 and 1440),
  sort_order            smallint not null default 0,
  -- [effective_from, effective_to): inclusive, exclusive. A version with
  -- equal dates never applied and is kept only because something points at it.
  effective_from        date not null,
  effective_to          date,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by_member_id  bigint,
  updated_by_member_id  bigint,
  unique (property_id, id),
  check (effective_to is null or effective_to >= effective_from),
  foreign key (property_id, lineage_id) references shifts (property_id, id),
  -- The rule the whole model rests on: one version per shift per day.
  constraint shifts_one_version_per_day exclude using gist (
    property_id with =,
    lineage_id with =,
    daterange(effective_from, effective_to, '[)') with &&
  )
);

create or replace function fn_shift_first_version_is_own_lineage() returns trigger
language plpgsql as $$
begin
  if new.lineage_id is null then
    new.lineage_id := new.id;
  end if;
  return new;
end $$;
create trigger shifts_default_lineage before insert on shifts
  for each row execute function fn_shift_first_version_is_own_lineage();
create trigger shifts_touch before update on shifts
  for each row execute function fn_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Production — one entry per machine, per date, per shift
-- ---------------------------------------------------------------------------

create table production_entries (
  id                    bigint generated always as identity primary key,
  property_id           bigint not null references properties (id) on delete cascade,
  machine_id            bigint not null,
  work_date             date not null,
  shift_id              bigint not null,
  total_stitches        bigint not null default 0 check (total_stitches >= 0),
  emb_minutes           smallint not null default 0 check (emb_minutes between 0 and 1440),
  stop_minutes          smallint not null default 0 check (stop_minutes between 0 and 1440),
  thread_breaks         integer not null default 0 check (thread_breaks >= 0),
  frames                integer not null default 0 check (frames >= 0),
  design_no             text check (length(design_no) <= 40),
  design_name           text check (length(design_name) <= 80),
  design_stitches       bigint check (design_stitches >= 0),
  -- Chooses which bonus rule pays.
  has_head_loss         boolean not null default false,
  -- The second-machine tick: paid at the stitch-based rate instead of a
  -- rule, and does not count toward attendance.
  is_stitch_based       boolean not null default false,
  -- The whole machine's bonus, split equally between its operators.
  bonus_amount          numeric(12,2) not null default 0 check (bonus_amount >= 0),
  -- Typed over by hand: recalculating leaves it alone.
  bonus_is_manual       boolean not null default false,
  note                  text,
  -- The photo of the machine's report the figures were scanned from.
  slip_photo_file_id    uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by_member_id  bigint,
  updated_by_member_id  bigint,
  deleted_at            timestamptz,
  deleted_by_member_id  bigint,
  deleted_batch         uuid,
  unique (property_id, id),
  -- Deleted rows included, on purpose: recording over a slot whose entry is
  -- in the bin reuses that row rather than destroying it.
  unique (machine_id, work_date, shift_id),
  check (emb_minutes + stop_minutes <= 1440),
  -- Restrict, not cascade: a purge removes a machine's entries first and
  -- deliberately. A cascade could take a live slip with it.
  foreign key (property_id, machine_id) references machines (property_id, id) on delete restrict,
  foreign key (property_id, shift_id) references shifts (property_id, id) on delete restrict,
  foreign key (property_id, slip_photo_file_id) references files (property_id, id)
    on delete set null (slip_photo_file_id)
);
create index production_live_by_date
  on production_entries (property_id, work_date) where deleted_at is null;
create index production_by_shift on production_entries (shift_id, work_date);
create trigger production_entries_touch before update on production_entries
  for each row execute function fn_touch_updated_at();

-- Who ran the machine. Also how attendance is recorded: being on an entry
-- marks the operator present for its date, or half a day when flagged.
create table entry_karigars (
  property_id  bigint not null,
  entry_id     bigint not null,
  staff_id     bigint not null,
  is_half_day  boolean not null default false,
  primary key (entry_id, staff_id),
  foreign key (property_id, entry_id) references production_entries (property_id, id)
    on delete cascade,
  -- Restrict: a person who ran machines is never hard-deleted, or their
  -- share of each bonus would pass to whoever else was on the machine.
  foreign key (property_id, staff_id) references staff (property_id, id)
    on delete restrict
);
create index entry_karigars_by_staff on entry_karigars (staff_id);

-- ---------------------------------------------------------------------------
-- Attendance (hajari) marked by hand
-- ---------------------------------------------------------------------------

-- Covers everyone who does not run a machine, and overrides what production
-- implies when a correction is needed. The resolved day is vw_attendance_days.
create table attendance_marks (
  id                    bigint generated always as identity primary key,
  property_id           bigint not null references properties (id) on delete cascade,
  staff_id              bigint not null,
  work_date             date not null,
  status                text not null default 'present'
                        check (status in ('present', 'halfDay', 'absent')),
  note                  text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by_member_id  bigint,
  updated_by_member_id  bigint,
  -- Clearing a mark is soft. Only "clear this month" carries a batch and so
  -- appears in the recycle bin; a day tapped back to unmarked does not.
  deleted_at            timestamptz,
  deleted_by_member_id  bigint,
  deleted_batch         uuid,
  unique (property_id, id),
  -- Deleted rows included: marking a cleared day again revives its row.
  unique (staff_id, work_date),
  foreign key (property_id, staff_id) references staff (property_id, id) on delete cascade
);
create index attendance_marks_live_by_date
  on attendance_marks (property_id, work_date) where deleted_at is null;
create trigger attendance_marks_touch before update on attendance_marks
  for each row execute function fn_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Advances (upad)
-- ---------------------------------------------------------------------------

-- What is still owed is worked out from the payslips (fn_advance_outstanding),
-- never kept as a running total. The client's recovered_amount column was
-- never written, and every advance was deducted again each month; it is not
-- carried over.
create table advances (
  id                    bigint generated always as identity primary key,
  property_id           bigint not null references properties (id) on delete cascade,
  staff_id              bigint not null,
  given_on              date not null,
  amount                numeric(12,2) not null check (amount > 0),
  mode                  text not null default 'cash' check (mode in ('cash', 'bank')),
  note                  text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by_member_id  bigint,
  updated_by_member_id  bigint,
  deleted_at            timestamptz,
  deleted_by_member_id  bigint,
  deleted_batch         uuid,
  unique (property_id, id),
  foreign key (property_id, staff_id) references staff (property_id, id) on delete cascade
);
create index advances_live_by_staff
  on advances (property_id, staff_id, given_on) where deleted_at is null;
create trigger advances_touch before update on advances
  for each row execute function fn_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Payslips — a snapshot, so a paid month stays what was paid
-- ---------------------------------------------------------------------------

create table salary_payments (
  id                    bigint generated always as identity primary key,
  property_id           bigint not null references properties (id) on delete cascade,
  staff_id              bigint not null,
  -- [period_start, period_end): a calendar month.
  period_start          date not null,
  period_end            date not null,
  days_worked           numeric(5,1) not null default 0 check (days_worked between 0 and 31),
  -- Salary / pay days, left exact; only amounts of money are rounded.
  per_day_rate          numeric(12,4) not null default 0 check (per_day_rate >= 0),
  stitches_in_period    bigint not null default 0 check (stitches_in_period >= 0),
  base_amount           numeric(12,2) not null default 0 check (base_amount >= 0),
  bonus_amount          numeric(12,2) not null default 0 check (bonus_amount >= 0),
  no_leave_bonus        numeric(12,2) not null default 0 check (no_leave_bonus >= 0),
  -- As it stood when paid: the person's setting may change afterwards.
  salary_was_cut        boolean not null default true,
  advance_deducted      numeric(12,2) not null default 0 check (advance_deducted >= 0),
  other_deductions      numeric(12,2) not null default 0 check (other_deductions >= 0),
  net_payable           numeric(12,2) not null default 0 check (net_payable >= 0),
  paid_amount           numeric(12,2) not null default 0 check (paid_amount >= 0),
  status                text not null default 'draft'
                        check (status in ('draft', 'approved', 'paid')),
  paid_on               timestamptz,
  note                  text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by_member_id  bigint,
  updated_by_member_id  bigint,
  deleted_at            timestamptz,
  deleted_by_member_id  bigint,
  deleted_batch         uuid,
  unique (property_id, id),
  check (period_end > period_start),
  check (status <> 'paid' or paid_on is not null),
  foreign key (property_id, staff_id) references staff (property_id, id) on delete cascade
);
-- One live payslip per person per month: a double tap on "Mark as paid" once
-- recorded a month twice and doubled the year's totals.
create unique index salary_payments_live_period
  on salary_payments (staff_id, period_start) where deleted_at is null;
create trigger salary_payments_touch before update on salary_payments
  for each row execute function fn_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Bonus rules and their stitch ladders
-- ---------------------------------------------------------------------------

create table bonus_rules (
  id                    bigint generated always as identity primary key,
  property_id           bigint not null references properties (id) on delete cascade,
  name                  text not null check (length(btrim(name)) between 1 and 60),
  is_active             boolean not null default true,
  -- A rule is written for one machine state; the first active match pays.
  condition             text not null default 'fullHead'
                        check (condition in ('fullHead', 'headLoss')),
  kind                  text not null default 'perThousandSlab'
                        check (kind in ('perThousandSlab', 'fixedSlab', 'flatPlusSlab', 'perFrame')),
  flat_amount           numeric(12,2) not null default 0 check (flat_amount >= 0),
  rate_per_frame        numeric(12,4) not null default 0 check (rate_per_frame >= 0),
  sort_order            smallint not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  created_by_member_id  bigint,
  updated_by_member_id  bigint,
  deleted_at            timestamptz,
  deleted_by_member_id  bigint,
  deleted_batch         uuid,
  unique (property_id, id)
);
create trigger bonus_rules_touch before update on bonus_rules
  for each row execute function fn_touch_updated_at();

-- One band: from_stitches <= stitches < to_stitches; a null top is the
-- open-ended last band. Replaced wholesale when the rule is saved.
create table bonus_slabs (
  id             bigint generated always as identity primary key,
  property_id    bigint not null,
  rule_id        bigint not null,
  from_stitches  bigint not null default 0 check (from_stitches >= 0),
  to_stitches    bigint check (to_stitches is null or to_stitches > from_stitches),
  -- ₹ per 1,000 stitches, or a flat ₹, depending on the rule's kind.
  value          numeric(12,4) not null default 0 check (value >= 0),
  foreign key (property_id, rule_id) references bonus_rules (property_id, id) on delete cascade,
  -- The editor refuses overlapping bands; so does the database.
  constraint bonus_slabs_no_overlap exclude using gist (
    rule_id with =,
    int8range(from_stitches, to_stitches, '[)') with &&
  )
);

-- ---------------------------------------------------------------------------
-- Report scans — what a photo of a machine's report was read as
-- ---------------------------------------------------------------------------

-- Kept so the reader can be tuned against the unit's real machine screens:
-- no photo of one had been seen when scanning was built. The recognised
-- lines are exactly what readSlip() in sf_core consumed.
create table slip_scans (
  id                    bigint generated always as identity primary key,
  property_id           bigint not null references properties (id) on delete cascade,
  machine_id            bigint not null,
  -- Set once the slip the scan filled is saved.
  entry_id              bigint,
  photo_file_id         uuid not null,
  engine                text not null check (engine in ('mlkitLatin', 'server')),
  -- [{"text": "...", "left": 0, "top": 0, "right": 0, "bottom": 0}, ...]
  lines                 jsonb not null default '[]'::jsonb,
  -- {"totalStitches": {"value": 145230, "confidence": 0.9, "source": "..."}, ...}
  reading               jsonb not null default '{}'::jsonb,
  created_by_member_id  bigint,
  created_at            timestamptz not null default now(),
  foreign key (property_id, machine_id) references machines (property_id, id) on delete cascade,
  foreign key (property_id, entry_id) references production_entries (property_id, id)
    on delete set null (entry_id),
  foreign key (property_id, photo_file_id) references files (property_id, id) on delete cascade,
  check (jsonb_typeof(lines) = 'array'),
  check (jsonb_typeof(reading) = 'object')
);
create index slip_scans_by_machine on slip_scans (property_id, machine_id, created_at desc);

-- Who-did-it columns point at members of the same property.
do $$
declare
  t text;
  c text;
begin
  foreach t in array array['machines', 'staff', 'shifts', 'production_entries',
                           'attendance_marks', 'advances', 'salary_payments',
                           'bonus_rules', 'slip_scans']
  loop
    foreach c in array array['created_by_member_id', 'updated_by_member_id', 'deleted_by_member_id']
    loop
      if exists (select 1 from information_schema.columns
                 where table_name = t and column_name = c) then
        execute format(
          'alter table %I add foreign key (property_id, %I) '
          'references property_members (property_id, id) on delete set null (%I)',
          t, c, c);
      end if;
    end loop;
  end loop;
end $$;
