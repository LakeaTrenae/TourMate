/**
 * Thin, non-throwing wrapper around the send-notification edge function.
 * Called right after a real mutation already succeeded (added to a
 * team, shared a document, approved/denied a guest) — a failure here
 * should never surface as an error on the screen that just completed
 * successfully, so this swallows and logs rather than throwing. Same
 * "best-effort side effect" pattern already used for storage cleanup in
 * DocumentsScreen.confirmDelete.
 */
import { supabase } from './supabase';

export async function notify(params: {
  tourId: string;
  targetUserIds: string[];
  title: string;
  body: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  if (params.targetUserIds.length === 0) return;
  try {
    const { error } = await supabase.functions.invoke('send-notification', { body: params });
    if (error) console.warn('Notification failed to send:', error.message);
  } catch (err) {
    console.warn('Notification failed to send:', err instanceof Error ? err.message : err);
  }
}
