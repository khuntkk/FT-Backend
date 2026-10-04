// The TypeScript rule must give the database's answer, every time.
//
// Builds a property with a member of every role — owner and not, active and
// switched off, with and without module grants — and asks both
// fn_member_can (SQL) and can() (TypeScript) about every action.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACTIONS, MODULES, UserRoleValues, can, canCreate, canGrant, memberLevel } from '../dist/index.js';

const dbDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db');
const db = new PGlite({ extensions: { btree_gist, citext } });
for (const sub of ['migrations', 'views']) {
  for (const f of readdirSync(join(dbDir, sub)).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(dbDir, sub, f), 'utf8'));
  }
}
const val = async (sql, params) => Object.values((await db.query(sql, params)).rows[0])[0];

const property = await val(`insert into properties (code, name, machine_limit) values ('parity', 'Parity', 10) returning id`);

// Every member shape worth asking about.
const grantSets = [
  {},
  { payroll: 'edit', production: 'none' },
  { attendance: 'view', users: 'edit', settings: 'edit', staff: 'view' },
  { production: 'view', machines: 'edit', shifts: 'edit', recycle_bin: 'none' },
];
const members = [];
let n = 0;
for (const role of UserRoleValues) {
  for (const isOwner of role === 'superAdmin' ? [true, false] : [false]) {
    for (const status of ['active', 'disabled']) {
      for (const grants of grantSets) {
        n++;
        const userId = await val(`insert into users (display_name, username) values ($1, $2) returning id`,
          [`User ${n}`, `user${n}`]);
        // Only one owner per property: each owner gets a property of their own.
        const pid = isOwner
          ? await val(`insert into properties (code, name, machine_limit) values ($1, $2, 10) returning id`, [`owner-${n}`, `Owner ${n}`])
          : property;
        const memberId = await val(
          `insert into property_members (property_id, user_id, role, is_owner, status)
           values ($1, $2, $3, $4, $5) returning id`, [pid, userId, role, isOwner, status]);
        for (const [module, level] of Object.entries(grants)) {
          await db.query(`insert into member_module_access (member_id, module, level) values ($1, $2, $3)`,
            [memberId, module, level]);
        }
        members.push({ memberId, ctx: { role, isOwner, status, grants } });
      }
    }
  }
}

test('can() agrees with fn_member_can for every member and action', async () => {
  let checked = 0;
  for (const { memberId, ctx } of members) {
    for (const action of Object.keys(ACTIONS)) {
      const sql = await val(`select fn_member_can($1, $2)`, [memberId, action]);
      assert.equal(can(ctx, action), sql, `${ctx.role}${ctx.isOwner ? ' (owner)' : ''} ${ctx.status} ${JSON.stringify(ctx.grants)} → ${action}`);
      checked++;
    }
  }
  // Every member shape against every action — nothing skipped.
  assert.equal(checked, members.length * Object.keys(ACTIONS).length);
});

test('memberLevel() agrees with fn_member_level for every module', async () => {
  for (const { memberId, ctx } of members) {
    for (const { key } of MODULES) {
      const sql = await val(`select fn_member_level($1, $2)`, [memberId, key]);
      assert.equal(memberLevel(ctx, key), sql, `${ctx.role} ${JSON.stringify(ctx.grants)} → ${key}`);
    }
  }
});

test('canCreate() agrees with fn_member_can_create', async () => {
  for (const { memberId, ctx } of members) {
    for (const role of UserRoleValues) {
      const sql = await val(`select fn_member_can_create($1, $2)`, [memberId, role]);
      assert.equal(canCreate(ctx, role), sql, `${ctx.role}${ctx.isOwner ? ' (owner)' : ''} ${ctx.status} creates ${role}`);
    }
  }
});

test('canGrant() agrees with fn_can_grant', async () => {
  for (const { memberId, ctx } of members.filter((m) => m.ctx.status === 'active')) {
    for (const granteeRole of UserRoleValues) {
      for (const { key } of MODULES) {
        for (const level of ['none', 'view', 'edit']) {
          const sql = await val(`select fn_can_grant($1, $2, $3, $4)`, [memberId, granteeRole, key, level]);
          assert.equal(canGrant(ctx, granteeRole, key, level), sql,
            `${ctx.role} grants ${granteeRole} ${key}=${level}`);
        }
      }
    }
  }
});
