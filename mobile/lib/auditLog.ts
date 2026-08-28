/**
 * Thin, non-throwing wrapper around inserting into `audit_log`
 * (0031_audit_log.sql) — called right after the real mutation it's
 * recording already succeeded. A failed log write should never surface
 * as an error on a screen whose actual action already completed, so
 * this swallows and logs rather than throwing — same "best-effort side
 * effect" pattern as lib/notify.ts.
 */
import { supabase } from './supabase';

export type AuditAction = 'create' | 'update' | 'delete' | 'share' | 'unshare' | 'approve' | 'deny';
export type AuditResourceType = 'budget_item' | 'settlement' | 'tour_member' | 'artist_contact' | 'resource_share';

export async function logAuditEvent(params: {
  tourId: string;
  actorId: string;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId?: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    const { error } = await supabase.from('audit_log').insert({
      tour_id: params.tourId,
      actor_id: params.actorId,
      action: params.action,
      resource_type: params.resourceType,
      resource_id: params.resourceId ?? null,
      detail: params.detail ?? null,
    });
    if (error) console.warn('Audit log write failed:', error.message);
  } catch (err) {
    console.warn('Audit log write failed:', err instanceof Error ? err.message : err);
  }
}
