import type { ActionKey, ModuleKey } from './generated/catalog.js';
import type { AccessLevel, AccountStatus, PropertyStatus, UserRole } from './generated/types.js';
/** What the rule needs to know about a member. */
export interface MemberContext {
    role: UserRole;
    isOwner: boolean;
    /** The membership. */
    status?: AccountStatus;
    /** The login. */
    userStatus?: AccountStatus;
    propertyStatus?: PropertyStatus;
    /** Their own module grants, if any; the role's defaults otherwise. */
    grants?: Partial<Record<ModuleKey, AccessLevel>>;
}
/** none < view < edit. */
export declare const atLeast: (level: AccessLevel, needed: AccessLevel) => boolean;
/** A member's level on a module: their grant, else the role default, never above the ceiling. */
export declare function memberLevel(m: MemberContext, module: ModuleKey): AccessLevel;
/** Every module with the level that applies — what `/me` returns. */
export declare function memberModules(m: MemberContext): {
    module: ModuleKey;
    level: AccessLevel;
}[];
/**
 * Whether a member may perform an action.
 *
 *   inactive member, login or property  → no
 *   owner-only action                   → the owner
 *   destructive action                  → a super admin, whatever the module level
 *   otherwise                           → the module level meets the action's
 */
export declare function can(m: MemberContext, action: ActionKey): boolean;
/** Why an action is refused, as the API's error code — or null if it is allowed. */
export declare function refusal(m: MemberContext, action: ActionKey): 'property_suspended' | 'forbidden' | 'owner_only' | 'super_admin_only' | null;
/** Whether a member may create — and so manage — a member of `role`. */
export declare function canCreate(m: MemberContext, role: UserRole): boolean;
/** Whether a grant is within what the granter has and within the grantee role's ceiling. */
export declare function canGrant(granter: MemberContext, granteeRole: UserRole, module: ModuleKey, level: AccessLevel): boolean;
/** The actions a member may perform — handy for a UI that hides what it cannot do. */
export declare function allowedActions(m: MemberContext): ActionKey[];
//# sourceMappingURL=permissions.d.ts.map