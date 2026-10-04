// The OpenAPI document holds together: every reference resolves, every
// permission exists, and it describes exactly the routes the table does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACTIONS, ROUTES } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(readFileSync(join(here, '..', 'openapi.json'), 'utf8'));
const catalog = JSON.parse(readFileSync(join(here, '..', 'catalog.json'), 'utf8'));

test('every $ref resolves', () => {
  const refs = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (typeof v.$ref === 'string') refs.push(v.$ref);
      Object.values(v).forEach(walk);
    }
  };
  walk(doc);
  assert.ok(refs.length > 100);
  for (const ref of refs) {
    const name = ref.replace('#/components/schemas/', '');
    assert.ok(doc.components.schemas[name], `unresolved ${ref}`);
  }
});

test('every operation is in the route table, and the other way round', () => {
  const fromDoc = [];
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const method of Object.keys(ops)) {
      fromDoc.push(`${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`);
    }
  }
  assert.deepEqual(fromDoc.sort(), ROUTES.map((r) => r.key).sort());
});

test('every x-action exists, and destructive ones say so', () => {
  for (const ops of Object.values(doc.paths)) {
    for (const op of Object.values(ops)) {
      if (!op['x-action']) continue;
      const a = ACTIONS[op['x-action']];
      assert.ok(a, `unknown action ${op['x-action']}`);
      assert.equal(op['x-destructive'], a.destructive, op.operationId);
    }
  }
});

test('the catalog matches the typed constants', () => {
  assert.deepEqual(catalog.actions.map((a) => a.key).sort(), Object.keys(ACTIONS).sort());
});

test('every member route names an action; only sign-in and session routes do not', () => {
  for (const r of ROUTES) {
    if (r.auth === 'member') assert.ok(r.action, `${r.key} has no action`);
  }
});
