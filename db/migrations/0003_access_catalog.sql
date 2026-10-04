-- 0003 · Access catalog: modules, what each role gets, what each action needs.
--
-- Reference data the API's permission checks read. Changing a default here
-- changes it for every member who has not been given their own grant — which
-- is the point, and also why it goes through a migration and review.
--
-- The rules this encodes (HANDOVER.md §6):
--   * Anything destructive — deleting of any kind, a shift schedule change,
--     emptying the bin — is super admin only, whatever the module level.
--   * Everyone else with edit on a module may add and change its data, and
--     delete only what is not destructive: a single attendance mark tapped
--     back to unmarked, the undo of "mark the rest present".
--   * A view admin is view only. A supervisor is shown nothing about pay.

insert into modules (key, name, sort_order) values
  ('production',  'Production & slips',      10),
  ('attendance',  'Attendance',              20),
  ('advances',    'Advances',                30),
  ('payroll',     'Salary & payslips',       40),
  ('staff',       'Operators & staff',       50),
  ('machines',    'Machines',                60),
  ('shifts',      'Shifts',                  70),
  ('bonus_rules', 'Bonus rules',             80),
  ('recycle_bin', 'Recently deleted',        90),
  ('users',       'Users & access',         100),
  ('settings',    'Unit settings',          110);

-- (role, module, default level, ceiling)
insert into role_module_defaults (role, module, level, max_level) values
  -- Super admin: everything.
  ('superAdmin', 'production',  'edit', 'edit'),
  ('superAdmin', 'attendance',  'edit', 'edit'),
  ('superAdmin', 'advances',    'edit', 'edit'),
  ('superAdmin', 'payroll',     'edit', 'edit'),
  ('superAdmin', 'staff',       'edit', 'edit'),
  ('superAdmin', 'machines',    'edit', 'edit'),
  ('superAdmin', 'shifts',      'edit', 'edit'),
  ('superAdmin', 'bonus_rules', 'edit', 'edit'),
  ('superAdmin', 'recycle_bin', 'edit', 'edit'),
  ('superAdmin', 'users',       'edit', 'edit'),
  ('superAdmin', 'settings',    'edit', 'edit'),
  -- Admin: day-to-day running. Sees the schedule but cannot change it (a
  -- change is destructive); restores from the bin but cannot empty it.
  ('admin', 'production',  'edit', 'edit'),
  ('admin', 'attendance',  'edit', 'edit'),
  ('admin', 'advances',    'edit', 'edit'),
  ('admin', 'payroll',     'edit', 'edit'),
  ('admin', 'staff',       'edit', 'edit'),
  ('admin', 'machines',    'edit', 'edit'),
  ('admin', 'shifts',      'view', 'view'),
  ('admin', 'bonus_rules', 'edit', 'edit'),
  ('admin', 'recycle_bin', 'edit', 'edit'),
  ('admin', 'users',       'edit', 'edit'),
  ('admin', 'settings',    'view', 'edit'),
  -- View admin: reads everything, pay included, changes nothing.
  ('viewAdmin', 'production',  'view', 'view'),
  ('viewAdmin', 'attendance',  'view', 'view'),
  ('viewAdmin', 'advances',    'view', 'view'),
  ('viewAdmin', 'payroll',     'view', 'view'),
  ('viewAdmin', 'staff',       'view', 'view'),
  ('viewAdmin', 'machines',    'view', 'view'),
  ('viewAdmin', 'shifts',      'view', 'view'),
  ('viewAdmin', 'bonus_rules', 'view', 'view'),
  ('viewAdmin', 'recycle_bin', 'view', 'view'),
  ('viewAdmin', 'users',       'view', 'view'),
  ('viewAdmin', 'settings',    'view', 'view'),
  -- Supervisor: runs the floor, records slips and attendance, adds sub
  -- users for operators. Never shown pay — the roster, advances, payslips
  -- and bonus rules all carry money — and nothing can raise that.
  ('supervisor', 'production',  'edit', 'edit'),
  ('supervisor', 'attendance',  'edit', 'edit'),
  ('supervisor', 'advances',    'none', 'none'),
  ('supervisor', 'payroll',     'none', 'none'),
  ('supervisor', 'staff',       'none', 'none'),
  ('supervisor', 'machines',    'view', 'view'),
  ('supervisor', 'shifts',      'view', 'view'),
  ('supervisor', 'bonus_rules', 'none', 'none'),
  ('supervisor', 'recycle_bin', 'none', 'none'),
  ('supervisor', 'users',       'edit', 'edit'),
  ('supervisor', 'settings',    'none', 'none'),
  -- Worker (Operator, in the Crew app): photographs and records slips, sees
  -- their own attendance. Scoping to their own machines is a later change.
  ('worker', 'production',  'edit', 'edit'),
  ('worker', 'attendance',  'view', 'view'),
  ('worker', 'advances',    'none', 'none'),
  ('worker', 'payroll',     'none', 'none'),
  ('worker', 'staff',       'none', 'none'),
  ('worker', 'machines',    'view', 'view'),
  ('worker', 'shifts',      'view', 'view'),
  ('worker', 'bonus_rules', 'none', 'none'),
  ('worker', 'recycle_bin', 'none', 'none'),
  ('worker', 'users',       'none', 'none'),
  ('worker', 'settings',    'none', 'none');

-- Who may create whom. Sub users are made by super admins, admins and
-- supervisors; each can only hand out access up to their own.
insert into role_can_create (creator_role, created_role) values
  ('superAdmin', 'admin'),
  ('superAdmin', 'viewAdmin'),
  ('superAdmin', 'supervisor'),
  ('superAdmin', 'worker'),
  ('admin',      'viewAdmin'),
  ('admin',      'supervisor'),
  ('admin',      'worker'),
  ('supervisor', 'worker');

-- (key, module, min level, destructive, owner only, description)
insert into actions (key, module, min_level, destructive, owner_only, description) values
  ('production.view',            'production',  'view', false, false, 'See slips, totals and machine pages'),
  ('production.record',          'production',  'edit', false, false, 'Record or change a slip'),
  ('production.scan',            'production',  'edit', false, false, 'Scan a machine''s report into a slip'),
  ('production.delete',          'production',  'edit', true,  false, 'Delete a slip'),

  ('attendance.view',            'attendance',  'view', false, false, 'See attendance'),
  ('attendance.mark',            'attendance',  'edit', false, false, 'Mark present, half day or absent'),
  ('attendance.unmark',          'attendance',  'edit', false, false, 'Tap a day back to unmarked, or undo a bulk mark'),
  ('attendance.clear_month',     'attendance',  'edit', true,  false, 'Clear a whole month of someone''s marks'),

  ('advances.view',              'advances',    'view', false, false, 'See advances and balances'),
  ('advances.record',            'advances',    'edit', false, false, 'Record an advance'),
  ('advances.delete',            'advances',    'edit', true,  false, 'Delete an advance'),

  ('payroll.view',               'payroll',     'view', false, false, 'See salaries and payslips'),
  ('payroll.mark_paid',          'payroll',     'edit', false, false, 'Mark a month paid'),
  ('payroll.delete_payslip',     'payroll',     'edit', true,  false, 'Delete a payslip'),

  ('staff.view',                 'staff',       'view', false, false, 'See the roster'),
  ('staff.create',               'staff',       'edit', false, false, 'Add a person'),
  ('staff.update',               'staff',       'edit', false, false, 'Change a person, their pay or their status'),
  ('staff.delete',               'staff',       'edit', true,  false, 'Delete a person'),

  ('machines.view',              'machines',    'view', false, false, 'See machines'),
  ('machines.create',            'machines',    'edit', false, false, 'Add machines'),
  ('machines.update',            'machines',    'edit', false, false, 'Change a machine''s details'),
  ('machines.delete',            'machines',    'edit', true,  false, 'Delete a machine'),

  ('shifts.view',                'shifts',      'view', false, false, 'See the shifts'),
  ('shifts.change',              'shifts',      'edit', true,  false, 'Change the schedule: arrangement, start time, add, edit, remove, Smart Adjust, undo'),

  ('bonus_rules.view',           'bonus_rules', 'view', false, false, 'See bonus rules'),
  ('bonus_rules.save',           'bonus_rules', 'edit', false, false, 'Add or change a rule, or switch one on or off'),
  ('bonus_rules.delete',         'bonus_rules', 'edit', true,  false, 'Delete a rule'),

  ('recycle_bin.view',           'recycle_bin', 'view', false, false, 'See recently deleted'),
  ('recycle_bin.restore',        'recycle_bin', 'edit', false, false, 'Restore something deleted'),
  ('recycle_bin.delete_forever', 'recycle_bin', 'edit', true,  false, 'Delete something for good'),
  ('recycle_bin.empty',          'recycle_bin', 'edit', true,  false, 'Empty the bin'),

  ('users.view',                 'users',       'view', false, false, 'See who can sign in'),
  ('users.create',               'users',       'edit', false, false, 'Add a user, up to one''s own access'),
  ('users.update_access',        'users',       'edit', false, false, 'Change a user''s modules, up to one''s own access'),
  ('users.reset_password',       'users',       'edit', false, false, 'Set a temporary password for a user one manages'),
  ('users.disable',              'users',       'edit', false, false, 'Switch a user''s sign-in off or back on'),
  ('users.remove',               'users',       'edit', true,  false, 'Remove a user from the unit'),
  ('users.manage_super_admins',  'users',       'edit', true,  true,  'Make or remove a super admin'),
  ('users.transfer_ownership',   'users',       'edit', true,  true,  'Hand the unit to another super admin'),

  ('settings.view',              'settings',    'view', false, false, 'See unit settings'),
  ('settings.update',            'settings',    'edit', false, false, 'Change business name, currency, no-leave bonus, stitch-based rate'),
  ('settings.reset_data',        'settings',    'edit', true,  true,  'Wipe the unit''s records');
