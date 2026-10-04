// A small vocabulary for describing the API's data once, from which both the
// OpenAPI document and the TypeScript types are generated. Nothing here is
// clever: each helper returns a plain descriptor the generator walks.

// --- Primitives -------------------------------------------------------------

export const id = { kind: 'integer', format: 'int64', doc: 'Server-issued id.' };
export const int = { kind: 'integer' };
export const num = { kind: 'number' };
export const bool = { kind: 'boolean' };
export const str = { kind: 'string' };
export const uuid = { kind: 'string', format: 'uuid' };
/** A calendar date with no time: "YYYY-MM-DD". Never a timestamp at local midnight. */
export const date = { kind: 'string', format: 'date', ts: 'DateOnly' };
/** An instant, ISO-8601 in UTC: "2026-09-27T09:30:00Z". */
export const instant = { kind: 'string', format: 'date-time', ts: 'Instant' };
/** A calendar month: "YYYY-MM". */
export const month = { kind: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$', ts: 'Month' };
/** Money, already rounded to the paisa by the server. */
export const money = { kind: 'number', multipleOf: 0.01, doc: 'Rupees, two decimals.' };
/** A rate, up to four decimals. */
export const rate = { kind: 'number', doc: 'Up to four decimals.' };
/** Minutes past midnight, 0–1439. */
export const minuteOfDay = { kind: 'integer', minimum: 0, maximum: 1439 };
export const minutes = { kind: 'integer', minimum: 0, maximum: 1440 };
/** Anything JSON. */
export const any = { kind: 'any' };

// --- Composition ------------------------------------------------------------

export const ref = (name) => ({ kind: 'ref', name });
export const arr = (items) => ({ kind: 'array', items });
/** An object whose keys are a closed set (keyEnum) or free strings. */
export const map = (values, keyEnum = null) => ({ kind: 'map', values, keyEnum });
export const oneOfEnum = (name) => ref(name);

/** The value may be null. Still sent, as null. */
export const nul = (s) => ({ ...s, nullable: true });
/** The key may be left out. */
export const opt = (s) => ({ ...s, optional: true });
/** Both: may be left out, and may be null. */
export const optNul = (s) => opt(nul(s));
/** Attach a description. */
export const doc = (s, text) => ({ ...s, doc: text });

// --- Named schemas ----------------------------------------------------------

export const enumOf = (values, description) => ({ kind: 'enum', values, doc: description });
export const object = (properties, description) => ({ kind: 'object', properties, doc: description });
