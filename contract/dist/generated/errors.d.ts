export type ErrorCode = "validation_failed" | "unauthenticated" | "token_expired" | "forbidden" | "super_admin_only" | "owner_only" | "password_change_required" | "property_suspended" | "not_found" | "machine_number_taken" | "machine_limit_reached" | "staff_code_taken" | "period_already_paid" | "restore_blocked" | "shift_cycle_clash" | "slab_ladder_invalid" | "grant_exceeds_granter" | "file_too_large" | "rate_limited";
/** The HTTP status each code is sent with. */
export declare const ERROR_STATUS: Record<ErrorCode, number>;
/** What each code means, and what its details carry. */
export declare const ERROR_MEANING: Record<ErrorCode, string>;
//# sourceMappingURL=errors.d.ts.map