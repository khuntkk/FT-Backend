import type { AccessLevel, UserRole } from './types.js';
export declare const MODULES: readonly [{
    readonly key: "production";
    readonly name: "Production & slips";
    readonly sortOrder: 10;
}, {
    readonly key: "attendance";
    readonly name: "Attendance";
    readonly sortOrder: 20;
}, {
    readonly key: "advances";
    readonly name: "Advances";
    readonly sortOrder: 30;
}, {
    readonly key: "payroll";
    readonly name: "Salary & payslips";
    readonly sortOrder: 40;
}, {
    readonly key: "staff";
    readonly name: "Operators & staff";
    readonly sortOrder: 50;
}, {
    readonly key: "machines";
    readonly name: "Machines";
    readonly sortOrder: 60;
}, {
    readonly key: "shifts";
    readonly name: "Shifts";
    readonly sortOrder: 70;
}, {
    readonly key: "bonus_rules";
    readonly name: "Bonus rules";
    readonly sortOrder: 80;
}, {
    readonly key: "recycle_bin";
    readonly name: "Recently deleted";
    readonly sortOrder: 90;
}, {
    readonly key: "users";
    readonly name: "Users & access";
    readonly sortOrder: 100;
}, {
    readonly key: "settings";
    readonly name: "Unit settings";
    readonly sortOrder: 110;
}];
export type ModuleKey = (typeof MODULES)[number]['key'];
export interface ActionInfo {
    module: ModuleKey;
    minLevel: 'view' | 'edit';
    /** Super admin only, whatever the module level. */
    destructive: boolean;
    /** The property's main super admin only. */
    ownerOnly: boolean;
    description: string;
}
export declare const ACTIONS: {
    readonly "advances.delete": {
        readonly module: "advances";
        readonly minLevel: "edit";
        readonly destructive: true;
        readonly ownerOnly: false;
        readonly description: "Delete an advance";
    };
    readonly "advances.record": {
        readonly module: "advances";
        readonly minLevel: "edit";
        readonly destructive: false;
        readonly ownerOnly: false;
        readonly description: "Record an advance";
    };
    readonly "advances.view": {
        readonly module: "advances";
        readonly minLevel: "view";
        readonly destructive: false;
        readonly ownerOnly: false;
        readonly description: "See advances and balances";
    };
    readonly "attendance.clear_month": {
        readonly module: "attendance";
        readonly minLevel: "edit";
        readonly destructive: true;
        readonly ownerOnly: false;
        readonly description: "Clear a whole month of someone's marks";
    };
    readonly "attendance.mark": {
        readonly module: "attendance";
        readonly minLevel: "edit";
        readonly destructive: false;
        readonly ownerOnly: false;
        readonly description: "Mark present, half day or absent";
    };
    readonly "attendance.unmark": {
        readonly module: "attendance";
        readonly minLevel: "edit";
        readonly destructive: false;
        readonly ownerOnly: false;
        readonly description: "Tap a day back to unmarked, or undo a bulk mark";
    };
    readonly "attendance.view": {
        readonly module: "attendance";
        readonly minLevel: "view";
        readonly destructive: false;
        readonly ownerOnly: false;
        readonly description: "See attendance";
    };
    readonly "bonus_rules.delete": {
        readonly module: "bonus_rules";
        readonly minLevel: "edit";
        readonly destructive: true;
        readonly ownerOnly: false;
        readonly description: "Delete a rule";
    };
    readonly "bonus_rules.save": {
        readonly module: "bonus_rules";
        readonly minLevel: "edit";
        readonly destructive: false;
        readonly ownerOnly: false;
        readonly description: "Add or change a rule, or switch one on or off";
    };
    readonly "bonus_rules.view": {
        readonly module: "bonus_rules";
        readonly minLevel: "view";
        readonly destructive: false;
        readonly ownerOnly: false;
        readonly description: "See bonus rules";
    };
    readonly "machines.create": {
        readonly module: "machines";
        readonly minLevel: "edit";
        readonly destructive: false;
        readonly ownerOnly: false;
        readonly description: "Add machines";
    };
    readonly "machines.delete": {
        readonly module: "machines";
        readonly minLevel: "edit";
        readonly destructive: true;
        readonly ownerOnly: false;
        readonly description: "Delete a machine";
    };
    readonly "machines.update": {
        readonly module: "machines";
        readonly minLevel: "edit";
        readonly destructive: false;
        readonly ownerOnly: false;
        readonly description: "Change a machine's details";
    };
    readonly "machines.view": {
        readonly module: "machines";
        readonly minLevel: "view";
        readonly destructive: false;
        readonly ownerOnly: false;
        readonly description: "See machines";
    };
    readonly "payroll.delete_payslip": {
        readonly module: "payroll";
        readonly minLevel: "edit";
        readonly destructive: true;
        readonly ownerOnly: false;
        readonly description: "Delete a payslip";
    };
    readonly "payroll.mark_paid": {
        readonly module: "payroll";
        readonly minLevel: "edit";
        readonly destructive: false;
        readonly ownerOnly: false;
        readonly description: "Mark a month paid";
    };
    readonly "payroll.view": {
        readonly module: "payroll";
        readonly minLevel: "view";
        readonly destructive: false;
        readonly ownerOnly: false;
        readonly description: "See salaries and payslips";
    };
    readonly "production.delete": {
        readonly module: "production";
        readonly minLevel: "edit";
        readonly destructive: true;
        readonly ownerOnly: false;
        readonly description: "Delete a slip";
    };
    readonly "production.record": {
        readonly module: "production";
        readonly minLevel: "edit";
        readonly destructive: false;
        readonly ownerOnly: false;
        readonly description: "Record or change a slip";
    };
    readonly "production.scan": {
        readonly module: "production";
        readonly minLevel: "edit";
        readonly destructive: false;
        readonly ownerOnly: false;
        readonly description: "Scan a machine's report into a slip";
    };
    readonly "production.view": {
        readonly module: "production";
        readonly minLevel: "view";
        readonly destructive: false;
        readonly ownerOnly: false;
        readonly description: "See slips, totals and machine pages";
    };
    readonly "recycle_bin.delete_forever": {
        readonly module: "recycle_bin";
        readonly minLevel: "edit";
        readonly destructive: true;
        readonly ownerOnly: false;
        readonly description: "Delete something for good";
    };
    readonly "recycle_bin.empty": {
        readonly module: "recycle_bin";
        readonly minLevel: "edit";
        readonly destructive: true;
        readonly ownerOnly: false;
        readonly description: "Empty the bin";
    };
    readonly "recycle_bin.restore": {
        readonly module: "recycle_bin";
        readonly minLevel: "edit";
        readonly destructive: false;
        readonly ownerOnly: false;
        readonly description: "Restore something deleted";
    };
    readonly "recycle_bin.view": {
        readonly module: "recycle_bin";
        readonly minLevel: "view";
        readonly destructive: false;
        readonly ownerOnly: false;
        readonly description: "See recently deleted";
    };
    readonly "settings.reset_data": {
        readonly module: "settings";
        readonly minLevel: "edit";
        readonly destructive: true;
        readonly ownerOnly: true;
        readonly description: "Wipe the unit's records";
    };
    readonly "settings.update": {
        readonly module: "settings";
        readonly minLevel: "edit";
        readonly destructive: false;
        readonly ownerOnly: false;
        readonly description: "Change business name, currency, no-leave bonus, stitch-based rate";
    };
    readonly "settings.view": {
        readonly module: "settings";
        readonly minLevel: "view";
        readonly destructive: false;
        readonly ownerOnly: false;
        readonly description: "See unit settings";
    };
    readonly "shifts.change": {
        readonly module: "shifts";
        readonly minLevel: "edit";
        readonly destructive: true;
        readonly ownerOnly: false;
        readonly description: "Change the schedule: arrangement, start time, add, edit, remove, Smart Adjust, undo";
    };
    readonly "shifts.view": {
        readonly module: "shifts";
        readonly minLevel: "view";
        readonly destructive: false;
        readonly ownerOnly: false;
        readonly description: "See the shifts";
    };
    readonly "staff.create": {
        readonly module: "staff";
        readonly minLevel: "edit";
        readonly destructive: false;
        readonly ownerOnly: false;
        readonly description: "Add a person";
    };
    readonly "staff.delete": {
        readonly module: "staff";
        readonly minLevel: "edit";
        readonly destructive: true;
        readonly ownerOnly: false;
        readonly description: "Delete a person";
    };
    readonly "staff.update": {
        readonly module: "staff";
        readonly minLevel: "edit";
        readonly destructive: false;
        readonly ownerOnly: false;
        readonly description: "Change a person, their pay or their status";
    };
    readonly "staff.view": {
        readonly module: "staff";
        readonly minLevel: "view";
        readonly destructive: false;
        readonly ownerOnly: false;
        readonly description: "See the roster";
    };
    readonly "users.create": {
        readonly module: "users";
        readonly minLevel: "edit";
        readonly destructive: false;
        readonly ownerOnly: false;
        readonly description: "Add a user, up to one's own access";
    };
    readonly "users.disable": {
        readonly module: "users";
        readonly minLevel: "edit";
        readonly destructive: false;
        readonly ownerOnly: false;
        readonly description: "Switch a user's sign-in off or back on";
    };
    readonly "users.manage_super_admins": {
        readonly module: "users";
        readonly minLevel: "edit";
        readonly destructive: true;
        readonly ownerOnly: true;
        readonly description: "Make or remove a super admin";
    };
    readonly "users.remove": {
        readonly module: "users";
        readonly minLevel: "edit";
        readonly destructive: true;
        readonly ownerOnly: false;
        readonly description: "Remove a user from the unit";
    };
    readonly "users.reset_password": {
        readonly module: "users";
        readonly minLevel: "edit";
        readonly destructive: false;
        readonly ownerOnly: false;
        readonly description: "Set a temporary password for a user one manages";
    };
    readonly "users.transfer_ownership": {
        readonly module: "users";
        readonly minLevel: "edit";
        readonly destructive: true;
        readonly ownerOnly: true;
        readonly description: "Hand the unit to another super admin";
    };
    readonly "users.update_access": {
        readonly module: "users";
        readonly minLevel: "edit";
        readonly destructive: false;
        readonly ownerOnly: false;
        readonly description: "Change a user's modules, up to one's own access";
    };
    readonly "users.view": {
        readonly module: "users";
        readonly minLevel: "view";
        readonly destructive: false;
        readonly ownerOnly: false;
        readonly description: "See who can sign in";
    };
};
export type ActionKey = keyof typeof ACTIONS;
/** Each role's default level and ceiling per module. */
export declare const ROLE_DEFAULTS: Record<UserRole, Record<ModuleKey, {
    level: AccessLevel;
    maxLevel: AccessLevel;
}>>;
/** Which roles each role may create. Only the owner creates super admins. */
export declare const ROLE_CAN_CREATE: Record<UserRole, readonly Exclude<UserRole, 'superAdmin'>[]>;
//# sourceMappingURL=catalog.d.ts.map