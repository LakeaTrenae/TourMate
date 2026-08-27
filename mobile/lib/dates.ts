/**
 * Formatting for Postgres `date` columns (tour_dates.date, lodging.check_in/
 * check_out — no time component, no timezone).
 *
 * `new Date("2026-09-15")` parses the string as UTC midnight. Calling
 * `.toLocaleDateString()` on that then renders it in the LOCAL timezone —
 * for anyone west of UTC, that rolls back to the previous day (2026-09-15
 * displays as "Sep 14"). Every screen that shows a show date, check-in
 * date, etc. needs to go through this instead of `new Date(dateOnlyStr)`
 * directly.
 *
 * Not needed for `timestamptz` columns (flights.departure_time,
 * created_at, etc.) — those already carry an explicit UTC offset, so
 * `new Date(...)` parses them as an unambiguous instant with no
 * roll-back risk.
 */
export function parseDateOnly(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  // Local-timezone constructor (not the string constructor), so the
  // calendar date is exactly what's stored — no UTC round-trip involved.
  return new Date(year, month - 1, day);
}

export function formatDateOnly(dateStr: string, options: Intl.DateTimeFormatOptions): string {
  return parseDateOnly(dateStr).toLocaleDateString(undefined, options);
}
