/**
 * Client-generated UUIDs for multi-step inserts.
 *
 * WHY THIS EXISTS: on this project, `INSERT ... RETURNING` (what
 * supabase-js does when you chain `.select()` onto an `.insert()`) fails
 * with a row-level-security error on ANY table that has a trigger
 * attached — confirmed by direct testing: the identical insert succeeds
 * with a plain 201 and fails 403 the moment `Prefer: return=representation`
 * is added, and a trigger-free table (venues) was unaffected while
 * trigger-bearing tables (organizations, tours) both failed. Since nearly
 * every tour-scoped table has the completion-lock trigger from
 * 0005_tour_completion_lock.sql, this isn't an edge case — it'll bite any
 * insert that needs its new row's id for a follow-up insert (e.g.
 * creating a flight, then assigning passengers to it).
 *
 * THE FIX: don't ask the database for the id back. Generate it
 * client-side before inserting, pass it explicitly, and never chain
 * `.select()` onto a write against a trigger-bearing table. If a screen
 * genuinely needs the full row back after writing, do it as a separate,
 * subsequent `.select()` call instead of chaining it onto the insert.
 */
import * as Crypto from 'expo-crypto';

export function newId(): string {
  return Crypto.randomUUID();
}