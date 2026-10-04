import type { DateOnly, Month } from './generated/types.js';
/** "YYYY-MM-DD" from a Date's local calendar fields. */
export declare function toDateOnly(d: Date): DateOnly;
/** A local-midnight Date from "YYYY-MM-DD". Throws on anything else. */
export declare function parseDateOnly(s: DateOnly): Date;
export declare const isDateOnly: (s: string) => s is DateOnly;
/** "YYYY-MM" for the month a date falls in. */
export declare const toMonth: (d: Date | DateOnly) => Month;
/** A month as [start, end): the first of it and the first of the next. */
export declare function monthRange(month: Month): {
    start: DateOnly;
    end: DateOnly;
};
/** Days in a month. */
export declare const daysInMonth: (month: Month) => number;
/** Adds whole days to a calendar date. */
export declare function addDays(date: DateOnly, days: number): DateOnly;
/** The calendar date it is now in an IANA zone — a property's "today". */
export declare function todayIn(timeZone: string, now?: Date): DateOnly;
/** Rounds to the paisa, as every amount on a payslip is. */
export declare const roundMoney: (v: number) => number;
//# sourceMappingURL=dates.d.ts.map