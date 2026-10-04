// Applies every migration and view to a throwaway Postgres (PGlite — real
// Postgres compiled to WebAssembly, no server needed) and checks that the
// rules the apps depend on actually hold in the database.
//
//   cd db/check && npm install && npm run check
//
// Each check names the rule it pins. When a rule changes on purpose, change
// its check in the same commit.

import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite({ extensions: { btree_gist, citext } });

let failures = 0;
let passes = 0;
const ok = (cond, what) => {
  if (cond) { passes++; } else { failures++; console.error('  ✗', what); }
};
const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const val = async (sql, params) => Object.values(await one(sql, params) ?? {})[0];
const rejects = async (sql, params, what, pattern) => {
  try {
    await db.query(sql, params);
    ok(false, `${what} — expected an error`);
  } catch (e) {
    ok(!pattern || pattern.test(e.message), `${what} — got: ${e.message}`);
  }
};
const section = (name) => console.log(`• ${name}`);

// ---------------------------------------------------------------------------
section('applying migrations and views');
for (const sub of ['migrations', 'views']) {
  for (const f of readdirSync(join(root, sub)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(root, sub, f), 'utf8'));
  }
}
// The views are re-applied on every deploy, so applying them twice must work.
for (const f of readdirSync(join(root, 'views')).filter((f) => f.endsWith('.sql')).sort()) {
  await db.exec(readFileSync(join(root, 'views', f), 'utf8'));
}
ok(true, 'applied');

// ---------------------------------------------------------------------------
section('fixtures: two properties, one member of each role');
const A = await val(`insert into properties (code, name, machine_limit) values ('janki', 'Janki Creation', 50) returning id`);
const B = await val(`insert into properties (code, name, machine_limit) values ('other-unit', 'Other Unit', 50) returning id`);
await db.query(`insert into property_settings (property_id) values ($1), ($2)`, [A, B]);

const user = async (name, username) =>
  val(`insert into users (display_name, username) values ($1, $2) returning id`, [name, username]);
const member = async (property, userId, role, isOwner = false) =>
  val(`insert into property_members (property_id, user_id, role, is_owner)
       values ($1, $2, $3, $4) returning id`, [property, userId, role, isOwner]);

const owner = await member(A, await user('Kaushik', 'kaushik'), 'superAdmin', true);
const superAdmin2 = await member(A, await user('Second', 'second'), 'superAdmin');
const admin = await member(A, await user('Anita', 'anita'), 'admin');
const viewAdmin = await member(A, await user('Vikram', 'vikram'), 'viewAdmin');
const supervisor = await member(A, await user('Suresh', 'suresh'), 'supervisor');
const worker = await member(A, await user('Ramesh', 'ramesh'), 'worker');
const otherOwner = await member(B, await user('Other', 'other'), 'superAdmin', true);

const can = (m, action) => val(`select fn_member_can($1, $2)`, [m, action]);

// ---------------------------------------------------------------------------
section('permissions: destructive is super admin only');
ok(await can(owner, 'machines.delete'), 'owner deletes a machine');
ok(await can(superAdmin2, 'shifts.change'), 'a super admin changes the schedule');
ok(!(await can(admin, 'machines.delete')), 'an admin cannot delete a machine');
ok(await can(admin, 'machines.create'), 'an admin can add machines');
ok(await can(admin, 'machines.update'), 'an admin can change a machine');
ok(!(await can(admin, 'shifts.change')), 'an admin cannot change the schedule');
ok(await can(admin, 'recycle_bin.restore'), 'an admin can restore');
ok(!(await can(admin, 'recycle_bin.empty')), 'an admin cannot empty the bin');
ok(await can(admin, 'attendance.unmark'), 'unmarking a day is not destructive');
ok(!(await can(admin, 'attendance.clear_month')), 'clearing a month is destructive');

section('permissions: owner-only');
ok(await can(owner, 'settings.reset_data'), 'the owner can wipe the unit');
ok(!(await can(superAdmin2, 'settings.reset_data')), 'another super admin cannot');
ok(!(await can(superAdmin2, 'users.transfer_ownership')), 'nor hand the unit over');

section('permissions: view only, and no pay for a supervisor');
ok(await can(viewAdmin, 'payroll.view'), 'a view admin reads pay');
ok(!(await can(viewAdmin, 'production.record')), 'a view admin records nothing');
ok(!(await can(supervisor, 'payroll.view')), 'a supervisor never sees pay');
ok(!(await can(supervisor, 'staff.view')), '— nor the roster, which carries salaries');
ok(await can(supervisor, 'production.record'), 'a supervisor records slips');
ok(await can(supervisor, 'users.create'), 'a supervisor adds sub users');
ok(await can(worker, 'production.record'), 'an operator records slips');
ok(!(await can(worker, 'users.create')), 'an operator adds no one');

section('permissions: selected modules stay within the ceiling');
await db.query(`insert into member_module_access (member_id, module, level) values ($1, 'payroll', 'edit')`, [supervisor]);
ok(!(await can(supervisor, 'payroll.view')), 'a grant cannot lift a supervisor above none on pay');
await db.query(`insert into member_module_access (member_id, module, level) values ($1, 'production', 'edit')`, [viewAdmin]);
ok(!(await can(viewAdmin, 'production.record')), 'a grant cannot make a view admin an editor');
await db.query(`insert into member_module_access (member_id, module, level) values ($1, 'attendance', 'none')`, [worker]);
ok(!(await can(worker, 'attendance.view')), 'a grant can take a module away');
ok(await can(worker, 'production.record'), '— and leaves the others as they were');

section('permissions: who may create whom, and grant what');
const canCreate = (m, role) => val(`select fn_member_can_create($1, $2)`, [m, role]);
ok(await canCreate(owner, 'superAdmin'), 'the owner makes super admins');
ok(!(await canCreate(superAdmin2, 'superAdmin')), 'another super admin does not');
ok(await canCreate(admin, 'supervisor'), 'an admin makes supervisors');
ok(!(await canCreate(admin, 'admin')), 'an admin does not make admins');
ok(await canCreate(supervisor, 'worker'), 'a supervisor makes operators');
ok(!(await canCreate(supervisor, 'viewAdmin')), 'and nothing else');
const canGrant = (m, role, module, level) =>
  val(`select fn_can_grant($1, $2, $3, $4)`, [m, role, module, level]);
ok(await canGrant(supervisor, 'worker', 'production', 'edit'), 'a supervisor grants what they have');
ok(!(await canGrant(supervisor, 'worker', 'staff', 'view')), 'but not what they do not');

section('permissions: switched off means nothing');
await db.query(`update property_members set status = 'disabled' where id = $1`, [admin]);
ok(!(await can(admin, 'production.view')), 'a disabled member can do nothing');
await db.query(`update property_members set status = 'active' where id = $1`, [admin]);
await db.query(`update properties set status = 'suspended' where id = $1`, [B]);
ok(!(await can(otherOwner, 'production.view')), 'nor anyone in a suspended property');
await db.query(`update properties set status = 'active' where id = $1`, [B]);

// ---------------------------------------------------------------------------
section('constraints: one owner per property');
await rejects(`update property_members set is_owner = true where id = $1`, [superAdmin2],
  'a second owner', /property_members_one_owner/);

section('constraints: machine numbers are unique among live machines');
const machine = async (property, number) =>
  val(`insert into machines (property_id, number) values ($1, $2) returning id`, [property, number]);
const m1 = await machine(A, 1);
const m3 = await machine(A, 3);
await rejects(`insert into machines (property_id, number) values ($1, 3)`, [A], 'two live machine 3s',
  /machines_live_number/);
await db.query(`update machines set deleted_at = now() where id = $1`, [m3]);
const m3b = await machine(A, 3);
ok(m3b > m3, 'a number in the bin can be used again');
ok(await machine(B, 1), 'another property has its own machine 1');

section('constraints: one shift version per day');
const shift = async (property, name, start, from, to = null, lineage = null) =>
  val(`insert into shifts (property_id, lineage_id, name, start_minute, duration_minutes, effective_from, effective_to)
       values ($1, $2, $3, $4, 720, $5, $6) returning id`, [property, lineage, name, start, from, to]);
const day = await shift(A, 'Day', 480, '2000-01-01');
ok(await val(`select lineage_id = id from shifts where id = $1`, [day]), 'a first version is its own lineage');
await rejects(`insert into shifts (property_id, lineage_id, name, start_minute, duration_minutes, effective_from)
               values ($1, $2, 'Day', 540, 720, '2026-09-01')`, [A, day],
  'two versions of Day in effect on one date', /shifts_one_version_per_day/);
await db.query(`update shifts set effective_to = '2026-09-01' where id = $1`, [day]);
const day2 = await shift(A, 'Day', 540, '2026-09-01', null, day);
ok(day2, 'closing a version lets the next one start that day');
ok(await shift(A, 'Day', 600, '2026-10-01', '2026-10-01', day),
  'a version that never applied (equal dates) is kept alongside, overlapping nothing');
const night = await shift(A, 'Night', 1200, '2000-01-01');

section('constraints: tenant boundaries hold across foreign keys');
await rejects(`insert into production_entries (property_id, machine_id, work_date, shift_id)
               values ($1, $2, '2026-09-10', $3)`, [B, m1, day2],
  'a slip in one property on another property\'s machine');

section('constraints: slips, operators, payslips, slabs');
const staff = async (name, category = 'karigar') =>
  val(`insert into staff (property_id, name, category, monthly_salary) values ($1, $2, $3, 18000) returning id`,
    [A, name, category]);
const devo = await staff('Devo Chauhan');
const raju = await staff('Rajubhai Solanki');
const kiran = await staff('Kiran Mali', 'designer');
const entry = async (machineId, date, shiftId, extra = {}) =>
  val(`insert into production_entries (property_id, machine_id, work_date, shift_id, total_stitches, bonus_amount, is_stitch_based)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [A, machineId, date, shiftId, extra.stitches ?? 100000, extra.bonus ?? 0, extra.stitchBased ?? false]);
const crew = (entryId, staffId, half = false) =>
  db.query(`insert into entry_karigars (property_id, entry_id, staff_id, is_half_day) values ($1, $2, $3, $4)`,
    [A, entryId, staffId, half]);

const e1 = await entry(m1, '2026-09-10', day2, { bonus: 300 });
await crew(e1, devo);
await crew(e1, raju, true);
await rejects(`insert into production_entries (property_id, machine_id, work_date, shift_id)
               values ($1, $2, '2026-09-10', $3)`, [A, m1, day2], 'two slips for one machine, date and shift');
await rejects(`delete from staff where id = $1`, [devo], 'hard-deleting a person who ran a machine');

await db.query(`insert into salary_payments (property_id, staff_id, period_start, period_end)
                values ($1, $2, '2026-09-01', '2026-10-01')`, [A, devo]);
await rejects(`insert into salary_payments (property_id, staff_id, period_start, period_end)
               values ($1, $2, '2026-09-01', '2026-10-01')`, [A, devo], 'paying a month twice',
  /salary_payments_live_period/);

const rule = await val(`insert into bonus_rules (property_id, name) values ($1, 'Full head') returning id`, [A]);
await db.query(`insert into bonus_slabs (property_id, rule_id, from_stitches, to_stitches, value)
                values ($1, $2, 0, 100000, 1), ($1, $2, 100000, null, 1.5)`, [A, rule]);
await rejects(`insert into bonus_slabs (property_id, rule_id, from_stitches, to_stitches, value)
               values ($1, $2, 50000, 150000, 2)`, [A, rule], 'overlapping slabs', /bonus_slabs_no_overlap/);

// ---------------------------------------------------------------------------
section('attendance resolves as the apps resolve it');
const e2 = await entry(m1, '2026-09-11', day2);
await crew(e2, raju, true);
const e3 = await entry(m3b, '2026-09-11', day2);
await crew(e3, raju, true);                         // half on both: half day
const e4 = await entry(m3b, '2026-09-12', day2, { stitchBased: true });
await crew(e4, devo);                               // second machine: no credit
await db.query(`insert into attendance_marks (property_id, staff_id, work_date, status)
                values ($1, $2, '2026-09-10', 'absent'), ($1, $3, '2026-09-10', 'present')`, [A, raju, kiran]);
const att = async (staffId, date) =>
  one(`select status, from_production, day_value::text as v from vw_attendance_days
       where staff_id = $1 and work_date = $2`, [staffId, date]);
ok((await att(devo, '2026-09-10'))?.status === 'present', 'on a slip: present');
ok((await att(devo, '2026-09-10'))?.from_production === true, '— and marked as coming from production');
ok((await att(raju, '2026-09-10'))?.status === 'absent', 'a mark by hand wins over the slip');
ok((await att(raju, '2026-09-11'))?.status === 'halfDay', 'half on every slip that day: half day');
ok((await att(devo, '2026-09-12')) === undefined, 'a stitch-based slip gives no attendance');
ok((await att(kiran, '2026-09-10'))?.v === '1.0', 'a designer marked by hand counts a full day');
await db.query(`update attendance_marks set deleted_at = now() where staff_id = $1`, [raju]);
ok((await att(raju, '2026-09-10'))?.status === 'halfDay', 'clearing the mark falls back to the slip');

// ---------------------------------------------------------------------------
section('upad balance comes from the payslips');
await db.query(`insert into advances (property_id, staff_id, given_on, amount) values ($1, $2, '2026-08-03', 5000)`, [A, raju]);
const owed = (s, start, end) => val(`select fn_advance_outstanding($1, $2, $3)::text`, [s, start, end]);
ok(await owed(raju, '2026-08-01', '2026-09-01') === '5000.00', 'owed going into August');
await db.query(`insert into salary_payments (property_id, staff_id, period_start, period_end, advance_deducted, status, paid_on)
                values ($1, $2, '2026-08-01', '2026-09-01', 5000, 'paid', now())`, [A, raju]);
ok(await owed(raju, '2026-09-01', '2026-10-01') === '0.00', 'recovered in August, not deducted again in September');
ok(await owed(raju, '2026-07-01', '2026-08-01') === '0.00', 'an August advance is not owed from July');

section('payroll inputs for a month');
const inputs = await one(`select * from fn_payroll_inputs($1, '2026-09-01') where staff_id = $2`, [A, raju]);
ok(inputs.bonus_earned === '150.00' || Number(inputs.bonus_earned) === 150,
  `a shared machine splits its bonus (got ${inputs.bonus_earned})`);
ok(Number(inputs.days_worked) === 1.0, `half on the 10th and the 11th (got ${inputs.days_worked})`);
ok(inputs.every_day_present === false, 'not a full month');

// ---------------------------------------------------------------------------
section('recycle bin');
const batch = await val(`select gen_random_uuid()`);
const e5 = await entry(m3b, '2026-09-13', day2);
await db.query(`update production_entries set deleted_at = now() - interval '1 hour' where id = $1`, [e5]);
await db.query(`update machines set deleted_at = now(), deleted_batch = $2 where id = $1`, [m3b, batch]);
await db.query(`update production_entries set deleted_at = now(), deleted_batch = $2
                where machine_id = $1 and deleted_at is null`, [m3b, batch]);
const bin = (await db.query(`select kind, id, child_count from vw_recycle_bin where property_id = $1 order by kind, id`, [A])).rows;
const machineRow = bin.find((r) => r.kind === 'machine' && Number(r.id) === Number(m3b));
ok(machineRow?.child_count === 2, `a machine folds in the slips deleted with it (got ${machineRow?.child_count})`);
ok(bin.some((r) => r.kind === 'productionEntry' && Number(r.id) === Number(e5)),
  'a slip deleted on its own is listed on its own');
ok(bin.some((r) => r.kind === 'machine' && Number(r.id) === Number(m3)), 'the older machine 3 is there too');
// As the API deletes: a batch of its own, under a machine that is still live.
const m4 = await machine(A, 4);
const e6 = await entry(m4, '2026-09-14', day2);
await db.query(`update production_entries set deleted_at = now(), deleted_batch = gen_random_uuid() where id = $1`, [e6]);
ok((await db.query(`select 1 from vw_recycle_bin where kind = 'productionEntry' and id = $1`, [e6])).rows.length === 1,
  'a slip deleted on its own, with its own batch, under a live machine is listed');
await db.query(`insert into attendance_marks (property_id, staff_id, work_date, deleted_at, deleted_batch)
                select $1, $2, d::date, now(), $3 from generate_series('2026-09-01'::date, '2026-09-05', '1 day') d`,
  [A, kiran, await val(`select gen_random_uuid()`)]);
const cleared = bin.length;
const bin2 = (await db.query(`select kind, child_count from vw_recycle_bin where property_id = $1 and kind = 'attendance'`, [A])).rows;
ok(bin2.length === 1 && bin2[0].child_count === 5, 'a cleared month is one item of five days');
ok(cleared > 0, 'bin lists');

// ---------------------------------------------------------------------------
section('machine limit: ours to set, and every machine not in the bin counts');
const allowance = (p) =>
  one(`select machine_limit, machines_used, machines_left from vw_machine_allowance where property_id = $1`, [p]);
const overLimit = async (sql, params, what) => {
  try {
    await db.query(sql, params);
    ok(false, `${what} — expected the limit to refuse it`);
  } catch (e) {
    const d = e.detail ? JSON.parse(e.detail) : {};
    ok(e.code === '23514' && e.constraint === 'machine_limit' && Number.isInteger(d.limit) && Number.isInteger(d.used),
      `${what} — got: ${e.message}`);
  }
};
await rejects(`insert into properties (code, name) values ('no-limit', 'No Limit')`, [],
  'a property without a machine limit', /machine_limit/);
await db.query(`update properties set machine_limit = 3 where id = $1`, [B]); // B has machine 1
ok((await allowance(B)).machines_left === 2, 'one machine on a limit of 3 leaves two places');
await machine(B, 2);
const b3 = await machine(B, 3);
await overLimit(`insert into machines (property_id, number) values ($1, 4)`, [B], 'a fourth machine on a limit of 3');
await db.query(`update machines set is_active = false where id = $1`, [b3]);
await overLimit(`insert into machines (property_id, number) values ($1, 4)`, [B], 'switching a machine off frees nothing');
await db.query(`update machines set deleted_at = now() where id = $1`, [b3]);
ok(await machine(B, 4), 'deleting one frees its place');
await overLimit(`update machines set deleted_at = null where id = $1`, [b3], 'restoring it with no place left');
await db.query(`update properties set machine_limit = 5 where id = $1`, [B]);
await overLimit(`insert into machines (property_id, number) select $1, n from generate_series(5, 7) n`, [B],
  'adding three with two places left');
ok((await allowance(B)).machines_used === 3, 'and none of the three goes in');
await db.query(`insert into machines (property_id, number) select $1, n from generate_series(5, 6) n`, [B]);
ok((await allowance(B)).machines_left === 0, 'two fit exactly');
await db.query(`update properties set machine_limit = 2 where id = $1`, [B]);
const lowered = await allowance(B);
ok(lowered.machines_used === 5 && lowered.machines_left === 0, 'lowering the limit removes nothing');
await overLimit(`insert into machines (property_id, number) values ($1, 7)`, [B],
  'and nothing more goes in until it is under again');
await db.query(`update properties set machine_limit = 50 where id = $1`, [B]);

section('views read as the caller, so row-level security applies to them');
const ownerViews = (await db.query(
  `select relname from pg_class
    where relkind = 'v' and relnamespace = 'public'::regnamespace
      and not coalesce(reloptions @> array['security_invoker=true'], false)`)).rows.map((r) => r.relname);
ok(ownerViews.length === 0, `every view has security_invoker (not: ${ownerViews.join(', ')})`);

section('every table that belongs to a property has row-level security');
const openTables = (await db.query(
  `select c.relname from pg_class c
    where c.relkind = 'r' and c.relnamespace = 'public'::regnamespace and not c.relrowsecurity
      and exists (select 1 from pg_attribute a
                  where a.attrelid = c.oid and a.attname = 'property_id' and not a.attisdropped)`))
  .rows.map((r) => r.relname);
ok(openTables.length === 0, `row-level security on every tenant table (not: ${openTables.join(', ')})`);

// ---------------------------------------------------------------------------
section('row-level security: the API sees one property');
// Sign-in knows the user from `users`, which is not tenant-scoped.
const otherOwnerUser = await val(`select user_id from property_members where id = $1`, [otherOwner]);
await db.exec(`set role stitchflow_api`);
ok(Number(await val(`select count(*) from machines`)) === 0, 'no property set: no rows at all');
await db.exec(`set app.property_id = '${A}'`);
const visible = (await db.query(`select distinct property_id from machines`)).rows.map((r) => Number(r.property_id));
ok(visible.length === 1 && visible[0] === Number(A), 'only its own property\'s machines');
await rejects(`insert into machines (property_id, number) values ($1, 50)`, [B],
  'writing into another property', /row-level security/);
await rejects(`update audit_log set action = 'x'`, [], 'rewriting the audit log', /permission denied/);
await rejects(`insert into modules (key, name, sort_order) values ('x', 'x', 1)`, [],
  'changing the access catalog', /permission denied/);
await rejects(`update properties set machine_limit = 999 where id = $1`, [A],
  'a unit raising its own machine limit', /permission denied/);
ok(await machine(A, 60), 'the API adds a machine within its limit');
const allowances = (await db.query(`select property_id from vw_machine_allowance`)).rows;
ok(allowances.length === 1 && Number(allowances[0].property_id) === Number(A), 'its own allowance only');
for (const v of ['vw_recycle_bin', 'vw_member_access', 'vw_attendance_days']) {
  ok(Number(await val(`select count(*) from ${v} where property_id <> $1`, [A])) === 0,
    `nothing of another property through ${v}`);
}
const memberships = (await db.query(`select * from fn_user_memberships($1)`, [otherOwnerUser])).rows;
ok(memberships.length === 1 && Number(memberships[0].property_id) === Number(B),
  'sign-in can still list a user\'s own properties');
await db.exec(`reset app.property_id; reset role`);

section('row-level security: the platform sees every property');
await db.exec(`set role stitchflow_platform`);
ok(Number(await val(`select count(distinct property_id) from machines`)) === 2, 'both properties');
ok(Number(await val(`select count(*) from vw_machine_allowance`)) === 2, 'every property\'s allowance');
await db.query(`update properties set machine_limit = 60 where id = $1`, [B]);
ok(Number(await val(`select machine_limit from properties where id = $1`, [B])) === 60, 'and sets the machine limit');
await db.exec(`reset role`);

// ---------------------------------------------------------------------------
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
