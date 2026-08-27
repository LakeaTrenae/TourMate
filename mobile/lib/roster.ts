/**
 * Shared helper for screens that need to pick people from a tour's roster
 * (assigning flight passengers, lodging occupants, etc.) — used by both
 * AddFlightScreen and AddLodgingScreen so the query and shape live in one
 * place instead of being copy-pasted.
 */
import { supabase } from './supabase';

export type RosterMember = {
  user_id: string;
  display_name: string;
  department: string;
};

export async function fetchTourRoster(tourId: string): Promise<RosterMember[]> {
  const { data, error } = await supabase
    .from('tour_members')
    .select('user_id, department, profile:profiles(display_name)')
    .eq('tour_id', tourId);

  if (error) throw error;

  return ((data ?? []) as unknown as Array<{
    user_id: string;
    department: string;
    profile: { display_name: string } | null;
  }>).map((row) => ({
    user_id: row.user_id,
    department: row.department,
    display_name: row.profile?.display_name ?? 'Unknown',
  }));
}