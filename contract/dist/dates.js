// Dates and money as the contract means them.
//
// A date with no time — a work date, a pay period, a shift's effective date —
// travels as "YYYY-MM-DD" and is a *calendar* date, not an instant. Build and
// read it from the local calendar fields, never through toISOString(), which
// converts to UTC and moves an Indian midnight to the day before.
const pad = (n, width = 2) => String(n).padStart(width, '0');
/** "YYYY-MM-DD" from a Date's local calendar fields. */
export function toDateOnly(d) {
    return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** A local-midnight Date from "YYYY-MM-DD". Throws on anything else. */
export function parseDateOnly(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m)
        throw new RangeError(`not a date: ${s}`);
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (toDateOnly(d) !== s)
        throw new RangeError(`not a real date: ${s}`);
    return d;
}
export const isDateOnly = (s) => {
    try {
        parseDateOnly(s);
        return true;
    }
    catch {
        return false;
    }
};
/** "YYYY-MM" for the month a date falls in. */
export const toMonth = (d) => (typeof d === 'string' ? d : toDateOnly(d)).slice(0, 7);
/** A month as [start, end): the first of it and the first of the next. */
export function monthRange(month) {
    const m = /^(\d{4})-(\d{2})$/.exec(month);
    if (!m)
        throw new RangeError(`not a month: ${month}`);
    const y = Number(m[1]);
    const mo = Number(m[2]);
    return {
        start: `${m[1]}-${m[2]}-01`,
        end: mo === 12 ? `${pad(y + 1, 4)}-01-01` : `${m[1]}-${pad(mo + 1)}-01`,
    };
}
/** Days in a month. */
export const daysInMonth = (month) => {
    const { start } = monthRange(month);
    const d = parseDateOnly(start);
    return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
};
/** Adds whole days to a calendar date. */
export function addDays(date, days) {
    const d = parseDateOnly(date);
    return toDateOnly(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days));
}
/** The calendar date it is now in an IANA zone — a property's "today". */
export function todayIn(timeZone, now = new Date()) {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
        .format(now);
}
/** Rounds to the paisa, as every amount on a payslip is. */
export const roundMoney = (v) => Math.round(v * 100) / 100;
//# sourceMappingURL=dates.js.map