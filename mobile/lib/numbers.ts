/**
 * Shared numeric-field parsing for optional number inputs (guarantee,
 * ticket price, capacity, etc.) — a blank field is a legitimate "not set"
 * (parses to null), but a non-empty field that isn't a valid number is a
 * mistake the user should be told about, not silently discarded.
 *
 * Without this, `Number.parseFloat("abc")` is NaN, and NaN serializes to
 * `null` in JSON.stringify — so a typo would silently save as "not set"
 * with no error at all, exactly the kind of quiet data loss this exists
 * to prevent. Established convention already used by AddBudgetItemScreen
 * for its one numeric field; this generalizes it for screens with
 * several.
 */
export function parseOptionalNumber(raw: string, fieldLabel: string, kind: 'float' | 'int' = 'float'): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = kind === 'int' ? Number.parseInt(trimmed, 10) : Number.parseFloat(trimmed);
  if (Number.isNaN(value)) {
    throw new Error(`"${raw}" isn't a valid number for ${fieldLabel}.`);
  }
  return value;
}
