// The permission rule, for code: the same answers as the SQL functions in
// db/views/20_fn_access.sql (fn_member_level, fn_member_can,
// fn_member_can_create, fn_can_grant). test/parity.test.mjs checks every
// role and action against the database, so the two cannot drift.
//
// The API should still ask the database — this is for the API's middleware
// before a query, for the web admin panel and the apps to decide what to
// show, and for tests.
import { ACTIONS, MODULES, ROLE_CAN_CREATE, ROLE_DEFAULTS } from './generated/catalog.js';
const rank = { none: 1, view: 2, edit: 3 };
const byRank = ['none', 'none', 'view', 'edit'];
/** none < view < edit. */
export const atLeast = (level, needed) => rank[level] >= rank[needed];
/** A member's level on a module: their grant, else the role default, never above the ceiling. */
export function memberLevel(m, module) {
    if (m.isOwner)
        return 'edit';
    const d = ROLE_DEFAULTS[m.role][module];
    const wanted = m.grants?.[module] ?? d.level;
    return byRank[Math.min(rank[wanted], rank[d.maxLevel])];
}
/** Every module with the level that applies — what `/me` returns. */
export function memberModules(m) {
    return MODULES.map((mod) => ({ module: mod.key, level: memberLevel(m, mod.key) }));
}
const isActive = (m) => (m.status ?? 'active') === 'active' &&
    (m.userStatus ?? 'active') === 'active' &&
    (m.propertyStatus ?? 'active') === 'active';
/**
 * Whether a member may perform an action.
 *
 *   inactive member, login or property  → no
 *   owner-only action                   → the owner
 *   destructive action                  → a super admin, whatever the module level
 *   otherwise                           → the module level meets the action's
 */
export function can(m, action) {
    if (!isActive(m))
        return false;
    const a = ACTIONS[action];
    if (a.ownerOnly)
        return m.isOwner;
    if (a.destructive)
        return m.role === 'superAdmin';
    return atLeast(memberLevel(m, a.module), a.minLevel);
}
/** Why an action is refused, as the API's error code — or null if it is allowed. */
export function refusal(m, action) {
    if ((m.propertyStatus ?? 'active') !== 'active')
        return 'property_suspended';
    if (!isActive(m))
        return 'forbidden';
    const a = ACTIONS[action];
    if (a.ownerOnly)
        return m.isOwner ? null : 'owner_only';
    if (a.destructive)
        return m.role === 'superAdmin' ? null : 'super_admin_only';
    return atLeast(memberLevel(m, a.module), a.minLevel) ? null : 'forbidden';
}
/** Whether a member may create — and so manage — a member of `role`. */
export function canCreate(m, role) {
    if (!can(m, 'users.create'))
        return false;
    if (role === 'superAdmin')
        return m.isOwner;
    return ROLE_CAN_CREATE[m.role].includes(role);
}
/** Whether a grant is within what the granter has and within the grantee role's ceiling. */
export function canGrant(granter, granteeRole, module, level) {
    return rank[level] <= rank[memberLevel(granter, module)] &&
        rank[level] <= rank[ROLE_DEFAULTS[granteeRole][module].maxLevel];
}
/** The actions a member may perform — handy for a UI that hides what it cannot do. */
export function allowedActions(m) {
    return Object.keys(ACTIONS).filter((a) => can(m, a));
}
//# sourceMappingURL=permissions.js.map