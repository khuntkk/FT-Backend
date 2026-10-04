import type * as T from './types.js';
import type { ActionKey } from './catalog.js';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/**
 * Every route, keyed "METHOD /path". params are the path's :names, query the
 * query string, body the JSON body (FormData for an upload), response what a
 * 2xx carries (void for 204, a redirect or a stream).
 */
export interface ApiRoutes {
    /** Sign in with phone, email or username. */
    "POST /v1/auth/login": {
        params: {};
        query: {};
        body: T.LoginInput;
        response: T.LoginResult;
    };
    /** Act in one of the user's properties; also the switcher. */
    "POST /v1/auth/select-property": {
        params: {};
        query: {};
        body: T.SelectPropertyInput;
        response: T.TokenPair;
    };
    /** Rotate the refresh token. */
    "POST /v1/auth/refresh": {
        params: {};
        query: {};
        body: T.RefreshInput;
        response: T.TokenPair;
    };
    /** Revoke this session (?everywhere=true for all). */
    "POST /v1/auth/logout": {
        params: {};
        query: {
            everywhere?: boolean;
        };
        body: T.RefreshInput;
        response: void;
    };
    /** Change one's own password; clears mustChangePassword. */
    "POST /v1/auth/change-password": {
        params: {};
        query: {};
        body: T.ChangePasswordInput;
        response: void;
    };
    /** Who is signed in, where, and with which modules. */
    "GET /v1/me": {
        params: {};
        query: {};
        body: undefined;
        response: T.Me;
    };
    /** The unit's settings. */
    "GET /v1/settings": {
        params: {};
        query: {};
        body: undefined;
        response: T.PropertySettings;
    };
    /** Change unit settings. */
    "PATCH /v1/settings": {
        params: {};
        query: {};
        body: T.SettingsPatch;
        response: T.PropertySettings;
    };
    /** Wipe the unit's records (owner). */
    "POST /v1/settings/reset-data": {
        params: {};
        query: {};
        body: T.ResetDataInput;
        response: void;
    };
    /** Live machines by number. */
    "GET /v1/machines": {
        params: {};
        query: {
            activeOnly?: boolean;
        };
        body: undefined;
        response: T.Machine[];
    };
    /** How many machines the unit may have, has, and has left. */
    "GET /v1/machines/allowance": {
        params: {};
        query: {};
        body: undefined;
        response: T.MachineAllowance;
    };
    /** Add a machine, within the machine limit. */
    "POST /v1/machines": {
        params: {};
        query: {};
        body: T.MachineInput;
        response: T.Machine;
    };
    /** Create the missing numbers 1..upTo — all of them or, past the limit, none. */
    "POST /v1/machines/bulk": {
        params: {};
        query: {};
        body: T.BulkMachinesInput;
        response: T.BulkCreated;
    };
    /** Change a machine. */
    "PATCH /v1/machines/:id": {
        params: {
            id: number;
        };
        query: {};
        body: T.MachinePatch;
        response: T.Machine;
    };
    /** Delete a machine and its live slips (soft). */
    "DELETE /v1/machines/:id": {
        params: {
            id: number;
        };
        query: {};
        body: undefined;
        response: void;
    };
    /** The roster. */
    "GET /v1/staff": {
        params: {};
        query: {
            activeOnly?: boolean;
            category?: T.StaffCategory;
        };
        body: undefined;
        response: T.Staff[];
    };
    /** The next free code. */
    "GET /v1/staff/next-code": {
        params: {};
        query: {};
        body: undefined;
        response: T.NextCode;
    };
    /** One person. */
    "GET /v1/staff/:id": {
        params: {
            id: number;
        };
        query: {};
        body: undefined;
        response: T.Staff;
    };
    /** Add a person. */
    "POST /v1/staff": {
        params: {};
        query: {};
        body: T.StaffInput;
        response: T.Staff;
    };
    /** Change a person. */
    "PATCH /v1/staff/:id": {
        params: {
            id: number;
        };
        query: {};
        body: T.StaffPatch;
        response: T.Staff;
    };
    /** Delete a person, their advances and payslips (soft). */
    "DELETE /v1/staff/:id": {
        params: {
            id: number;
        };
        query: {};
        body: undefined;
        response: void;
    };
    /** People for the slip's picker — no pay. */
    "GET /v1/operators": {
        params: {};
        query: {
            activeOnly?: boolean;
        };
        body: undefined;
        response: T.Person[];
    };
    /** Every live, active machine with its entry. */
    "GET /v1/production/day": {
        params: {};
        query: {
            date: T.DateOnly;
            shiftId: number;
        };
        body: undefined;
        response: T.MachineDay[];
    };
    /** One machine, date and shift. */
    "GET /v1/production/entry": {
        params: {};
        query: {
            machineId: number;
            date: T.DateOnly;
            shiftId: number;
        };
        body: undefined;
        response: T.EntryWithKarigars;
    };
    /** Save a slip (upsert). The server works out the bonus. */
    "PUT /v1/production/entry": {
        params: {};
        query: {};
        body: T.EntryDraft;
        response: T.EntryWithKarigars;
    };
    /** Delete a slip (soft). */
    "DELETE /v1/production/entry/:id": {
        params: {
            id: number;
        };
        query: {};
        body: undefined;
        response: void;
    };
    /** Slips in a range, paged. */
    "GET /v1/production/entries": {
        params: {};
        query: {
            from: T.DateOnly;
            to: T.DateOnly;
            shiftId?: number;
            staffId?: number;
            limit?: number;
            cursor?: string;
        };
        body: undefined;
        response: T.EntryPage;
    };
    /** Totals for a range. */
    "GET /v1/production/totals": {
        params: {};
        query: {
            from: T.DateOnly;
            to: T.DateOnly;
            shiftId?: number;
        };
        body: undefined;
        response: T.ProductionTotals;
    };
    /** Totals per day with anything recorded. */
    "GET /v1/production/daily-totals": {
        params: {};
        query: {
            month: T.Month;
            shiftId?: number;
        };
        body: undefined;
        response: Record<string, T.ProductionTotals>;
    };
    /** Keep what a report photo was read as. */
    "POST /v1/production/scans": {
        params: {};
        query: {};
        body: T.ScanInput;
        response: T.CreatedId;
    };
    /** Everyone's resolved day. */
    "GET /v1/attendance/day": {
        params: {};
        query: {
            date: T.DateOnly;
            category?: T.StaffCategory;
        };
        body: undefined;
        response: T.StaffHajari[];
    };
    /** A month, summarised per day. */
    "GET /v1/attendance/daily": {
        params: {};
        query: {
            month: T.Month;
        };
        body: undefined;
        response: Record<string, T.AttendanceDay>;
    };
    /** One person's days in a range. */
    "GET /v1/staff/:id/attendance": {
        params: {
            id: number;
        };
        query: {
            from: T.DateOnly;
            to: T.DateOnly;
        };
        body: undefined;
        response: T.HajariDay[];
    };
    /** Mark one day. */
    "PUT /v1/attendance/mark": {
        params: {};
        query: {};
        body: T.MarkInput;
        response: void;
    };
    /** Mark many days for one person. */
    "PUT /v1/attendance/marks": {
        params: {};
        query: {};
        body: T.MarkManyInput;
        response: void;
    };
    /** Mark many people on one day. */
    "POST /v1/attendance/mark-all": {
        params: {};
        query: {};
        body: T.MarkAllInput;
        response: void;
    };
    /** A day back to unmarked (not in the bin). */
    "DELETE /v1/attendance/mark": {
        params: {};
        query: {
            staffId: number;
            date: T.DateOnly;
        };
        body: undefined;
        response: void;
    };
    /** Undo marking the rest present. */
    "POST /v1/attendance/undo-mark-all": {
        params: {};
        query: {};
        body: T.UndoMarkAllInput;
        response: void;
    };
    /** Clear a month of marks (one bin item). */
    "POST /v1/attendance/clear-month": {
        params: {};
        query: {};
        body: T.ClearMonthInput;
        response: void;
    };
    /** Advances, by month or person. */
    "GET /v1/advances": {
        params: {};
        query: {
            month?: T.Month;
            staffId?: number;
        };
        body: undefined;
        response: T.Advance[];
    };
    /** Owed going into a month (or now). */
    "GET /v1/staff/:id/advance-balance": {
        params: {
            id: number;
        };
        query: {
            month?: T.Month;
        };
        body: undefined;
        response: T.AdvanceBalance;
    };
    /** Record an advance. */
    "POST /v1/advances": {
        params: {};
        query: {};
        body: T.AdvanceInput;
        response: T.Advance;
    };
    /** Delete an advance (soft). */
    "DELETE /v1/advances/:id": {
        params: {
            id: number;
        };
        query: {};
        body: undefined;
        response: void;
    };
    /** A month's pay, one row per active person. */
    "GET /v1/payroll/preview": {
        params: {};
        query: {
            month: T.Month;
        };
        body: undefined;
        response: T.PayrollRow[];
    };
    /** Payslips by person or year. */
    "GET /v1/payroll/payslips": {
        params: {};
        query: {
            staffId?: number;
            year?: number;
        };
        body: undefined;
        response: T.SalaryPayment[];
    };
    /** Mark a month paid; returns the existing payslip if already paid. */
    "POST /v1/payroll/payslips": {
        params: {};
        query: {};
        body: T.PayslipInput;
        response: T.SalaryPayment;
    };
    /** Delete a payslip (soft). */
    "DELETE /v1/payroll/payslips/:id": {
        params: {
            id: number;
        };
        query: {};
        body: undefined;
        response: void;
    };
    /** Rules with ladders, in matching order. */
    "GET /v1/bonus-rules": {
        params: {};
        query: {};
        body: undefined;
        response: T.BonusRule[];
    };
    /** One rule. */
    "GET /v1/bonus-rules/:id": {
        params: {
            id: number;
        };
        query: {};
        body: undefined;
        response: T.BonusRule;
    };
    /** Add a rule. */
    "POST /v1/bonus-rules": {
        params: {};
        query: {};
        body: T.BonusRuleInput;
        response: T.BonusRule;
    };
    /** Replace a rule and its ladder. */
    "PUT /v1/bonus-rules/:id": {
        params: {
            id: number;
        };
        query: {};
        body: T.BonusRuleInput;
        response: T.BonusRule;
    };
    /** Switch a rule on or off. */
    "PATCH /v1/bonus-rules/:id": {
        params: {
            id: number;
        };
        query: {};
        body: T.BonusRuleToggle;
        response: T.BonusRule;
    };
    /** Delete a rule (soft). */
    "DELETE /v1/bonus-rules/:id": {
        params: {
            id: number;
        };
        query: {};
        body: undefined;
        response: void;
    };
    /** Versions in effect on a date. */
    "GET /v1/shifts": {
        params: {};
        query: {
            on: T.DateOnly;
        };
        body: undefined;
        response: T.Shift[];
    };
    /** Today's set. */
    "GET /v1/shifts/current": {
        params: {};
        query: {};
        body: undefined;
        response: T.Shift[];
    };
    /** The set Settings edits. */
    "GET /v1/shifts/editable": {
        params: {};
        query: {};
        body: undefined;
        response: T.Shift[];
    };
    /** When a change to these shifts can start. */
    "GET /v1/shifts/earliest-effective-date": {
        params: {};
        query: {
            shiftIds: number[];
        };
        body: undefined;
        response: T.DateResult;
    };
    /** Any version, retired ones included. */
    "GET /v1/shifts/:id": {
        params: {
            id: number;
        };
        query: {};
        body: undefined;
        response: T.Shift;
    };
    /** Switch arrangement and day start. */
    "PUT /v1/shifts/scheme": {
        params: {};
        query: {};
        body: T.SchemeInput;
        response: T.Shift[];
    };
    /** Add a shift. */
    "POST /v1/shifts": {
        params: {};
        query: {};
        body: T.ShiftInput;
        response: T.Shift;
    };
    /** Open a new version. */
    "PATCH /v1/shifts/:id": {
        params: {
            id: number;
        };
        query: {};
        body: T.ShiftPatch;
        response: T.Shift;
    };
    /** Take a shift out of the cycle. */
    "POST /v1/shifts/:id/retire": {
        params: {
            id: number;
        };
        query: {};
        body: undefined;
        response: void;
    };
    /** Smart Adjust. */
    "PUT /v1/shifts/timings": {
        params: {};
        query: {};
        body: T.TimingsInput;
        response: T.Shift[];
    };
    /** Undo to a known-good set. */
    "PUT /v1/shifts/restore": {
        params: {};
        query: {};
        body: T.RestoreShiftsInput;
        response: T.Shift[];
    };
    /** Everything deleted in the last seven days. */
    "GET /v1/recycle-bin": {
        params: {};
        query: {};
        body: undefined;
        response: T.DeletedItem[];
    };
    /** Restore an item and what went with it. */
    "POST /v1/recycle-bin/:kind/:id/restore": {
        params: {
            kind: T.DeletedKind;
            id: number;
        };
        query: {};
        body: undefined;
        response: void;
    };
    /** Delete an item for good. */
    "DELETE /v1/recycle-bin/:kind/:id": {
        params: {
            kind: T.DeletedKind;
            id: number;
        };
        query: {};
        body: undefined;
        response: void;
    };
    /** Empty the bin. */
    "DELETE /v1/recycle-bin": {
        params: {};
        query: {};
        body: undefined;
        response: void;
    };
    /** Who can sign in to this unit. */
    "GET /v1/users": {
        params: {};
        query: {};
        body: undefined;
        response: T.Member[];
    };
    /** Add a user with selected modules. */
    "POST /v1/users": {
        params: {};
        query: {};
        body: T.CreateUserInput;
        response: T.CreatedUser;
    };
    /** Change a user's modules. */
    "PATCH /v1/users/:memberId/access": {
        params: {
            memberId: number;
        };
        query: {};
        body: T.AccessPatch;
        response: T.Member;
    };
    /** Set a temporary password. */
    "POST /v1/users/:memberId/reset-password": {
        params: {
            memberId: number;
        };
        query: {};
        body: undefined;
        response: T.TemporaryPassword;
    };
    /** Switch a user's sign-in off. */
    "POST /v1/users/:memberId/disable": {
        params: {
            memberId: number;
        };
        query: {};
        body: undefined;
        response: T.Member;
    };
    /** Switch it back on. */
    "POST /v1/users/:memberId/enable": {
        params: {
            memberId: number;
        };
        query: {};
        body: undefined;
        response: T.Member;
    };
    /** Remove a user from the unit. */
    "DELETE /v1/users/:memberId": {
        params: {
            memberId: number;
        };
        query: {};
        body: undefined;
        response: void;
    };
    /** Make a super admin (owner). */
    "POST /v1/users/:memberId/super-admin": {
        params: {
            memberId: number;
        };
        query: {};
        body: undefined;
        response: T.Member;
    };
    /** Remove a super admin (owner). */
    "DELETE /v1/users/:memberId/super-admin": {
        params: {
            memberId: number;
        };
        query: {};
        body: undefined;
        response: T.Member;
    };
    /** Hand the unit to another super admin (owner). */
    "POST /v1/users/transfer-ownership": {
        params: {};
        query: {};
        body: T.TransferOwnershipInput;
        response: void;
    };
    /** Upload a photo (multipart: purpose, file). Checked against what it is for. */
    "POST /v1/files": {
        params: {};
        query: {};
        body: FormData;
        response: T.FileRef;
    };
    /** Redirects to a short-lived signed URL. */
    "GET /v1/files/:fileId": {
        params: {
            fileId: string;
        };
        query: {};
        body: undefined;
        response: void;
    };
    /** Server-sent change notices for this property. */
    "GET /v1/events": {
        params: {};
        query: {};
        body: undefined;
        response: void;
    };
    /** Platform staff sign-in. */
    "POST /v1/platform/auth/login": {
        params: {};
        query: {};
        body: T.PlatformLoginInput;
        response: T.TokenPair;
    };
    /** Search properties. */
    "GET /v1/platform/properties": {
        params: {};
        query: {
            query?: string;
            status?: T.PropertyStatus;
        };
        body: undefined;
        response: T.PropertySummary[];
    };
    /** Create a property and its owner. */
    "POST /v1/platform/properties": {
        params: {};
        query: {};
        body: T.CreatePropertyInput;
        response: T.CreatedProperty;
    };
    /** One property. */
    "GET /v1/platform/properties/:id": {
        params: {
            id: number;
        };
        query: {};
        body: undefined;
        response: T.PropertyDetail;
    };
    /** Rename, change zone, set the machine limit, suspend or reactivate. */
    "PATCH /v1/platform/properties/:id": {
        params: {
            id: number;
        };
        query: {};
        body: T.PropertyPatch;
        response: T.Property;
    };
    /** Move ownership for an owner who has left. */
    "POST /v1/platform/properties/:id/transfer-ownership": {
        params: {
            id: number;
        };
        query: {};
        body: T.TransferOwnershipInput;
        response: void;
    };
    /** Find a user by phone, email, username or name. */
    "GET /v1/platform/users": {
        params: {};
        query: {
            query: string;
        };
        body: undefined;
        response: T.PlatformUser[];
    };
    /** One user's memberships and sessions. */
    "GET /v1/platform/users/:id": {
        params: {
            id: number;
        };
        query: {};
        body: undefined;
        response: T.PlatformUser;
    };
    /** Set a temporary password. */
    "POST /v1/platform/users/:id/reset-password": {
        params: {
            id: number;
        };
        query: {};
        body: undefined;
        response: T.TemporaryPassword;
    };
    /** Switch a user off everywhere. */
    "POST /v1/platform/users/:id/disable": {
        params: {
            id: number;
        };
        query: {};
        body: undefined;
        response: T.User;
    };
    /** Switch them back on. */
    "POST /v1/platform/users/:id/enable": {
        params: {
            id: number;
        };
        query: {};
        body: undefined;
        response: T.User;
    };
    /** Sign a user out everywhere. */
    "DELETE /v1/platform/users/:id/sessions": {
        params: {
            id: number;
        };
        query: {};
        body: undefined;
        response: void;
    };
    /** The audit log, paged. */
    "GET /v1/platform/audit": {
        params: {};
        query: {
            propertyId?: number;
            actorUserId?: number;
            from?: T.DateOnly;
            to?: T.DateOnly;
            destructive?: boolean;
            limit?: number;
            cursor?: string;
        };
        body: undefined;
        response: T.AuditPage;
    };
    /** Our console users. */
    "GET /v1/platform/staff": {
        params: {};
        query: {};
        body: undefined;
        response: T.PlatformStaffMember[];
    };
    /** Add a console user. */
    "POST /v1/platform/staff": {
        params: {};
        query: {};
        body: T.PlatformStaffInput;
        response: T.CreatedPlatformStaff;
    };
    /** Remove a console user. */
    "DELETE /v1/platform/staff/:id": {
        params: {
            id: number;
        };
        query: {};
        body: undefined;
        response: void;
    };
}
export type RouteKey = keyof ApiRoutes;
export interface RouteInfo {
    key: RouteKey;
    method: HttpMethod;
    /** Express/Fastify style, with :params. */
    path: string;
    summary: string;
    /** The permission the route needs, or null for sign-in and session routes. */
    action: ActionKey | null;
    /** none: no token. session: any signed-in user. member: the action below. platform: console staff. */
    auth: 'none' | 'session' | 'member' | 'platform';
    platformRole: T.PlatformRole | null;
    destructive: boolean;
    ownerOnly: boolean;
}
export declare const ROUTES: readonly RouteInfo[];
//# sourceMappingURL=routes.d.ts.map