// 0010 converts a database that already has data: every bigint id becomes a
// UUID in place. check-schema.mjs only ever runs it on empty tables, so this
// builds the schema as it stood before (migrations 0001–0009 and the views of
// that time, frozen in pre-0010-views/), fills it with linked rows, converts,
// and checks that every link, every order and every safeguard survived.
//
//   cd db/check && node check-uuid-migration.mjs

import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const db = new PGlite({ extensions: { btree_gist, citext } });

let failures = 0;
let passes = 0;
const ok = (cond, what) => {
  if (cond) { passes++; } else { failures++; console.error('  ✗', what); }
};
const rows = async (sql, params) => (await db.query(sql, params)).rows;
const val = async (sql, params) => Object.values((await rows(sql, params))[0] ?? {})[0];
const sqlIn = (dir, filter = () => true) =>
  readdirSync(dir).filter((f) => f.endsWith('.sql') && filter(f)).sort().map((f) => readFileSync(join(dir, f), 'utf8'));
const section = (name) => console.log(`• ${name}`);

// ---------------------------------------------------------------------------
section('the schema before 0010, with Supabase\'s own tables beside it');
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  -- Supabase keeps users and sessions of its own in another schema; 0010 must
  -- leave them alone.
  create schema auth;
  create table auth.users (id bigint primary key, email text);
  create table auth.sessions (id bigint primary key, user_id bigint references auth.users (id));
  insert into auth.users values (1, 'a@b.c'); insert into auth.sessions values (7, 1);`);
for (const sql of sqlIn(join(root, 'migrations'), (f) => f < '0010')) await db.exec(sql);
for (const sql of sqlIn(join(here, 'pre-0010-views'))) await db.exec(sql);

// ---------------------------------------------------------------------------
section('linked data, as the API writes it');
// Rows written in one statement share created_at; the second property was
// created "earlier" than the first. Old-id order must still be kept.
await db.exec(`
  insert into properties (code, name, machine_limit) values ('janki', 'Janki Creation', 50), ('surat-two', 'Surat Two', 50);
  update properties set created_at = created_at - interval '1 day' where code = 'surat-two';
  insert into property_settings (property_id, business_name) select id, name from properties;
  insert into users (display_name, phone, email, password_hash) values
    ('Owner A', '+919800000001', 'owner@a.in', 'x'), ('Supervisor A', '+919800000002', null, 'x'),
    ('Owner B', '+919800000003', null, 'x'), ('Console Admin', null, 'admin@sf.in', 'x'), ('Console Support', null, 'support@sf.in', 'x');
  insert into platform_staff (user_id, role) select id, 'admin' from users where display_name = 'Console Admin';
  insert into platform_staff (user_id, role, created_by)
    select s.id, 'support', a.id from users s, users a where s.display_name = 'Console Support' and a.display_name = 'Console Admin';`);
const prop = async (code) => val(`select id from properties where code = $1`, [code]);
const user = async (name) => val(`select id from users where display_name = $1`, [name]);
const A = await prop('janki');
const B = await prop('surat-two');
await db.query(`insert into property_members (property_id, user_id, role, is_owner) values ($1, $2, 'superAdmin', true)`, [A, await user('Owner A')]);
await db.query(`insert into property_members (property_id, user_id, role, is_owner) values ($1, $2, 'superAdmin', true)`, [B, await user('Owner B')]);
const ownerA = await val(`select id from property_members where property_id = $1 and is_owner`, [A]);
await db.exec(`
  insert into staff (property_id, code, name, created_by_member_id) values
    (${A}, '1', 'Ramesh', ${ownerA}), (${A}, '2', 'Suresh', ${ownerA}), (${A}, '3', 'Mahesh', ${ownerA});
  insert into staff (property_id, code, name) values (${B}, '1', 'Bhavin');`);
const staffId = async (name) => val(`select id from staff where name = $1`, [name]);
await db.query(`insert into property_members (property_id, user_id, role, staff_id, created_by_member_id)
                values ($1, $2, 'supervisor', $3, $4)`, [A, await user('Supervisor A'), await staffId('Suresh'), ownerA]);
const supervisorA = await val(`select id from property_members where role = 'supervisor'`);
await db.query(`insert into member_module_access (member_id, module, level, granted_by_member_id)
                values ($1, 'attendance', 'edit', $2)`, [supervisorA, ownerA]);
await db.exec(`
  insert into machines (property_id, number, name, created_by_member_id) values
    (${A}, 1, 'Tajima', ${ownerA}), (${A}, 2, 'Barudan', ${ownerA}), (${A}, 3, 'Old one', ${ownerA});
  update machines set deleted_at = now(), deleted_by_member_id = ${ownerA}, deleted_batch = gen_random_uuid() where number = 3;
  insert into machines (property_id, number) values (${B}, 1);`);
const machineId = async (property, number) => val(`select id from machines where property_id = $1 and number = $2`, [property, number]);
// A shift with versions: the first is its own lineage; a never-applied one in between.
const day1 = await val(`insert into shifts (property_id, name, start_minute, duration_minutes, effective_from, effective_to)
                        values ($1, 'Day', 480, 720, '2026-01-01', '2026-09-01') returning id`, [A]);
await db.query(`insert into shifts (property_id, lineage_id, name, start_minute, duration_minutes, effective_from, effective_to)
                values ($1, $2, 'Day', 450, 720, '2026-09-01', '2026-09-01')`, [A, day1]);
await db.query(`insert into shifts (property_id, lineage_id, name, start_minute, duration_minutes, effective_from)
                values ($1, $2, 'Day', 420, 720, '2026-09-01')`, [A, day1]);
const night = await val(`insert into shifts (property_id, name, start_minute, duration_minutes, effective_from, sort_order)
                         values ($1, 'Night', 1200, 720, '2026-01-01', 1) returning id`, [A]);
await db.query(`insert into shifts (property_id, name, start_minute, duration_minutes, effective_from) values ($1, 'Day', 480, 720, '2026-01-01')`, [B]);
const photo = await val(`insert into files (property_id, purpose, storage_key, content_type, byte_size, sha256, created_by_member_id)
                         values ($1, 'slipPhoto', 'a/1.jpg', 'image/jpeg', 10, repeat('a', 64), $2) returning id`, [A, ownerA]);
const entry1 = await val(`insert into production_entries (property_id, machine_id, work_date, shift_id, total_stitches, bonus_amount, slip_photo_file_id, created_by_member_id)
                          values ($1, $2, '2026-09-10', $3, 152000, 120, $4, $5) returning id`, [A, await machineId(A, 1), day1, photo, ownerA]);
const entry2 = await val(`insert into production_entries (property_id, machine_id, work_date, shift_id, total_stitches)
                          values ($1, $2, '2026-09-10', $3, 98000) returning id`, [A, await machineId(A, 2), night]);
await db.query(`insert into entry_karigars (property_id, entry_id, staff_id) values ($1, $2, $3), ($1, $2, $4), ($1, $5, $3)`,
  [A, entry1, await staffId('Ramesh'), await staffId('Mahesh'), entry2]);
await db.query(`insert into slip_scans (property_id, machine_id, entry_id, photo_file_id, engine) values ($1, $2, $3, $4, 'mlkitLatin')`,
  [A, await machineId(A, 1), entry1, photo]);
await db.exec(`
  insert into attendance_marks (property_id, staff_id, work_date, status) values
    (${A}, ${await staffId('Suresh')}, '2026-09-01', 'present'), (${A}, ${await staffId('Suresh')}, '2026-09-02', 'halfDay'),
    (${A}, ${await staffId('Suresh')}, '2026-09-03', 'absent');
  update attendance_marks set deleted_at = now(), deleted_batch = '00000000-0000-4000-8000-000000000001' where work_date >= '2026-09-02';
  insert into advances (property_id, staff_id, given_on, amount) values
    (${A}, ${await staffId('Ramesh')}, '2026-09-05', 500), (${A}, ${await staffId('Ramesh')}, '2026-09-05', 300);
  insert into salary_payments (property_id, staff_id, period_start, period_end, advance_deducted, status, paid_on)
    values (${A}, ${await staffId('Ramesh')}, '2026-08-01', '2026-09-01', 200, 'paid', now());
  -- Two rules on one sort order: which one pays is decided by creation order.
  insert into bonus_rules (property_id, name, sort_order) values (${A}, 'Full head', 0), (${A}, 'Full head (old)', 0);`);
const rule = await val(`select id from bonus_rules where name = 'Full head'`);
await db.query(`insert into bonus_slabs (property_id, rule_id, from_stitches, to_stitches, value) values ($1, $2, 0, 100000, 0), ($1, $2, 100000, null, 1.5)`, [A, rule]);
await db.query(`insert into audit_log (property_id, actor_user_id, actor_member_id, action, entity_type, entity_id) values
  ($1, $2, $3, 'machines.delete', 'machine', $4::text),
  ($1, $2, $3, 'machines.delete', 'machine', '99999'),
  ($1, $2, $3, 'attendance.clear_month', 'attendance', $5::text),
  ($1, $2, null, 'platform.patch /properties/:id', 'property', $1::text),
  (null, $2, null, 'platform.post /staff', 'platformStaff', $2::text)`,
  [A, (await user('Owner A')), ownerA, await machineId(A, 3), await staffId('Suresh')]);
await db.query(`insert into auth_sessions (user_id, member_id, client, refresh_token_hash, family_id, expires_at)
                values ($1, $2, 'managerApp', 'h1', gen_random_uuid(), now() + interval '7 days')`, [await user('Owner A'), ownerA]);
await db.query(`insert into idempotency_keys (property_id, member_id, key, route) values ($1, $2, 'key-12345678', 'POST /v1/machines')`, [A, ownerA]);
ok(true, 'seeded');

// ---------------------------------------------------------------------------
// What must read the same after: each link followed by joins, shown without ids,
// and every table in its id order.
const LINKS = {
  'settings → property': `select p.code, s.business_name from property_settings s join properties p on p.id = s.property_id order by 1`,
  'staff → member → user': `select p.code, u.display_name, m.role, m.is_owner, s.name as staff, c.role as created_by
    from property_members m join properties p on p.id = m.property_id join users u on u.id = m.user_id
    left join staff s on s.id = m.staff_id left join property_members c on c.id = m.created_by_member_id order by 1, 2`,
  'grant → member, granter': `select gu.display_name as grantee, g.module, g.level, bu.display_name as granted_by
    from member_module_access g join property_members gm on gm.id = g.member_id join users gu on gu.id = gm.user_id
    join property_members bm on bm.id = g.granted_by_member_id join users bu on bu.id = bm.user_id order by 1`,
  'console staff → creator': `select u.display_name, ps.role, c.display_name as created_by
    from platform_staff ps join users u on u.id = ps.user_id left join users c on c.id = ps.created_by order by 1`,
  'machines and who': `select p.code, m.number, m.name, cu.display_name as created_by, du.display_name as deleted_by, m.deleted_at is not null as binned
    from machines m join properties p on p.id = m.property_id
    left join property_members c on c.id = m.created_by_member_id left join users cu on cu.id = c.user_id
    left join property_members d on d.id = m.deleted_by_member_id left join users du on du.id = d.user_id order by 1, 2`,
  'shift versions → lineage': `select p.code, s.name, s.start_minute, s.effective_from, s.effective_to,
    l.start_minute as lineage_start, s.id = s.lineage_id as first_version
    from shifts s join shifts l on l.id = s.lineage_id join properties p on p.id = s.property_id order by 1, 2, 4, 5 nulls last`,
  'slips → machine, shift, photo, operators': `select m.number, sh.name, sh.start_minute, e.total_stitches, f.storage_key,
    (select string_agg(st.name, ',' order by st.name) from entry_karigars k join staff st on st.id = k.staff_id where k.entry_id = e.id) as operators
    from production_entries e join machines m on m.id = e.machine_id join shifts sh on sh.id = e.shift_id
    left join files f on f.id = e.slip_photo_file_id order by 1`,
  'scans → machine, slip, photo': `select m.number, e.total_stitches, f.storage_key from slip_scans x
    join machines m on m.id = x.machine_id join production_entries e on e.id = x.entry_id join files f on f.id = x.photo_file_id`,
  'attendance, advances, payslips → person': `select 'mark' as kind, s.name, k.work_date::text as d, k.status as v from attendance_marks k join staff s on s.id = k.staff_id
    union all select 'advance', s.name, a.given_on::text, a.amount::text from advances a join staff s on s.id = a.staff_id
    union all select 'payslip', s.name, sp.period_start::text, sp.advance_deducted::text from salary_payments sp join staff s on s.id = sp.staff_id
    order by 1, 2, 3, 4`,
  'slabs → rule': `select r.name, sl.from_stitches, sl.to_stitches, sl.value from bonus_slabs sl join bonus_rules r on r.id = sl.rule_id order by 2`,
  'audit → property, actor': `select a.action, p.code, u.display_name, mu.display_name as member
    from audit_log a left join properties p on p.id = a.property_id left join users u on u.id = a.actor_user_id
    left join property_members m on m.id = a.actor_member_id left join users mu on mu.id = m.user_id order by 1, 2`,
  'files → property, member': `select p.code, f.storage_key, u.display_name from files f join properties p on p.id = f.property_id
    join property_members m on m.id = f.created_by_member_id join users u on u.id = m.user_id`,
};
const ORDER = {
  properties: 'code', users: 'display_name', property_members: 'role', machines: 'number', staff: 'name',
  shifts: 'start_minute', production_entries: 'total_stitches', attendance_marks: 'work_date', advances: 'amount',
  salary_payments: 'period_start', bonus_rules: 'name', bonus_slabs: 'from_stitches', slip_scans: 'engine', audit_log: 'action',
};
const snapshot = async () => {
  const out = {};
  for (const [name, sql] of Object.entries(LINKS)) out[name] = JSON.stringify(await rows(sql));
  for (const [t, col] of Object.entries(ORDER)) out[`order of ${t}`] = JSON.stringify((await rows(`select ${col}::text as v from ${t} order by id`)).map((r) => r.v));
  return out;
};
const before = await snapshot();
const firstVersions = Number(await val(`select count(*) from shifts where lineage_id = id`));
ok(firstVersions === 3, `three first versions before (got ${firstVersions})`);

// ---------------------------------------------------------------------------
section('converting, as the runner does: 0010 and the views in one transaction');
await db.exec('begin');
await db.exec(readFileSync(join(root, 'migrations', '0010_uuid_ids.sql'), 'utf8'));
for (const sql of sqlIn(join(root, 'views'))) await db.exec(sql);
await db.exec('commit');
for (const sql of sqlIn(join(root, 'views'))) await db.exec(sql);
ok(true, 'converted, and the views apply again on the next deploy');

// ---------------------------------------------------------------------------
section('every link and every order survived');
const after = await snapshot();
for (const key of Object.keys(before)) ok(before[key] === after[key], `${key}\n      before ${before[key]}\n      after  ${after[key]}`);
ok(Number(await val(`select count(*) from shifts where lineage_id = id`)) === firstVersions, 'first shift versions are still their own lineage');

section('ids are lower-case version 7 UUIDs');
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
for (const t of Object.keys(ORDER)) {
  const ids = (await rows(`select id::text as id from ${t}`)).map((r) => r.id);
  ok(ids.length > 0 && ids.every((id) => UUID_V7.test(id)), `${t}: ${ids.slice(0, 2).join(', ')}`);
}
const nowA = await val(`select id from properties where code = 'janki'`);
const newMachine = await val(`insert into machines (property_id, number) values ($1, 9) returning id`, [nowA]);
ok(UUID_V7.test(newMachine), 'a new row gets a version 7 id by default');
ok(newMachine > (await val(`select max(id::text) from machines where number <> 9`)), 'and it sorts after every converted row');
const newShift = await val(`insert into shifts (property_id, name, start_minute, duration_minutes, effective_from) values ($1, 'Third', 0, 480, '2026-10-01') returning id`, [nowA]);
ok(await val(`select lineage_id = id from shifts where id = $1`, [newShift]), 'a new shift is still its own lineage');

section('what had to be let go');
ok(Number(await val(`select count(*) from auth_sessions where revoked_at is null`)) === 0, 'every session is ended');
ok(await val(`select revoked_reason from auth_sessions limit 1`) === 'idsChanged', 'and says why');
ok(Number(await val(`select count(*) from idempotency_keys`)) === 0, 'stored replies with old numbers are gone');
const audit = Object.fromEntries((await rows(`select action || ' ' || coalesce(entity_type, '') as k, entity_id from audit_log`)).map((r) => [r.k + (r.entity_id === '99999' ? ' purged' : ''), r.entity_id]));
ok(audit['machines.delete machine'] === await val(`select id::text from machines where number = 3`), 'the audit log names a machine by its new id');
ok(audit['machines.delete machine purged'] === '99999', 'one deleted for good keeps its old number');
ok(audit['attendance.clear_month attendance'] === await val(`select id::text from staff where name = 'Suresh'`), 'marking names the person by their new id');
ok(audit['platform.patch /properties/:id property'] === await val(`select id::text from properties where code = 'janki'`),
  'a property by its new id');
ok(audit['platform.post /staff platformStaff'] === await val(`select id::text from users where display_name = 'Owner A'`),
  'console staff by their new user id');

section('nothing else changed');
ok(Number(await val(`select count(*) from pg_proc where pronamespace = pg_my_temp_schema()`)) === 0, 'no temporary functions are left');
ok(await val(`select data_type from information_schema.columns where table_schema = 'auth' and table_name = 'sessions' and column_name = 'user_id'`) === 'bigint',
  'Supabase\'s own auth tables are untouched');
ok(Number(await val(`select count(*) from auth.sessions s join auth.users u on u.id = s.user_id`)) === 1, 'and still linked');
ok(await val(`select data_type from information_schema.columns where table_name = 'production_entries' and column_name = 'total_stitches'`) === 'bigint',
  'stitch counts stay numbers');

section('row-level security still keeps properties apart');
const newA = await val(`select id from properties where code = 'janki'`);
await db.exec(`set role stitchflow_api`);
ok(Number(await val(`select count(*) from machines`)) === 0, 'no property set: no rows');
await db.exec(`set app.property_id = '${newA}'`);
ok((await rows(`select distinct property_id from machines`)).every((r) => r.property_id === newA), 'only its own property\'s machines');
ok(Number(await val(`select count(*) from member_module_access`)) === 1, 'its own members\' grants');
ok((await rows(`select * from fn_user_memberships((select user_id from property_members where id = (select id from property_members where is_owner and property_id = $1)))`, [newA])).length === 1,
  'sign-in still lists a user\'s properties');
await db.exec(`reset app.property_id; reset role`);

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
