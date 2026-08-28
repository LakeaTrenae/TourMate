/**
 * ChecklistSharingScreen — view and edit exactly who this checklist is
 * shared with, beyond the base visible_to_all / owning-department
 * visibility (0021). Structurally identical to DocumentSharingScreen —
 * same immediate-persist checkbox pattern, just resource_type
 * 'checklist' instead of 'document'.
 *
 * Reachable for whoever can edit the checklist (managers or the owning
 * department — mirrors can_edit_checklist, 0021), matching "resource_shares
 * insertable/deletable by resource owner" for the 'checklist' branch.
 */
import { useCallback, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { fetchTourRoster, type RosterMember } from '../lib/roster';
import { formatDepartment } from '../lib/format';
import { logAuditEvent } from '../lib/auditLog';
import { notify } from '../lib/notify';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'ChecklistSharing'>;

const DEPARTMENTS = ['production', 'security', 'travel', 'artist_relations', 'finance', 'tour_management', 'general'];

type Share = { id: string; shared_with_user_id: string | null; shared_with_department: string | null };

export function ChecklistSharingScreen({ route }: Props) {
  const { checklistId, tourId, checklistTitle } = route.params;
  const { session } = useAuth();

  const [visibleToAll, setVisibleToAll] = useState<boolean | null>(null);
  const [shares, setShares] = useState<Share[]>([]);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function load() {
    const [checklistRes, sharesRes, rosterList] = await Promise.all([
      supabase.from('checklists').select('visible_to_all').eq('id', checklistId).single(),
      supabase.from('resource_shares').select('id, shared_with_user_id, shared_with_department').eq('resource_type', 'checklist').eq('resource_id', checklistId),
      fetchTourRoster(tourId).catch(() => [] as RosterMember[]),
    ]);
    if (checklistRes.error) setErrorMessage(checklistRes.error.message);
    setVisibleToAll(checklistRes.data?.visible_to_all ?? null);
    if (sharesRes.error) setErrorMessage(sharesRes.error.message);
    setShares(sharesRes.data ?? []);
    setRoster(rosterList);
  }

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load().finally(() => setLoading(false));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [checklistId])
  );

  async function toggleUserShare(userId: string) {
    if (!session) return;
    setErrorMessage(null);
    const existing = shares.find((s) => s.shared_with_user_id === userId);
    if (existing) {
      const { error } = await supabase.from('resource_shares').delete().eq('id', existing.id);
      if (error) { setErrorMessage(error.message); return; }
      logAuditEvent({ tourId, actorId: session.user.id, action: 'unshare', resourceType: 'resource_share', resourceId: checklistId, detail: { resource_type: 'checklist', shared_with_user_id: userId } });
    } else {
      const { error } = await supabase.from('resource_shares').insert({
        tour_id: tourId,
        resource_type: 'checklist',
        resource_id: checklistId,
        shared_with_user_id: userId,
        permission: 'view',
        granted_by: session.user.id,
      });
      if (error) { setErrorMessage(error.message); return; }
      logAuditEvent({ tourId, actorId: session.user.id, action: 'share', resourceType: 'resource_share', resourceId: checklistId, detail: { resource_type: 'checklist', shared_with_user_id: userId } });
      notify({ tourId, targetUserIds: [userId], title: 'Checklist shared with you', body: checklistTitle, data: { type: 'checklist_share', checklistId } });
    }
    await load();
  }

  async function toggleDepartmentShare(department: string) {
    if (!session) return;
    setErrorMessage(null);
    const existing = shares.find((s) => s.shared_with_department === department);
    if (existing) {
      const { error } = await supabase.from('resource_shares').delete().eq('id', existing.id);
      if (error) { setErrorMessage(error.message); return; }
      logAuditEvent({ tourId, actorId: session.user.id, action: 'unshare', resourceType: 'resource_share', resourceId: checklistId, detail: { resource_type: 'checklist', shared_with_department: department } });
    } else {
      const { error } = await supabase.from('resource_shares').insert({
        tour_id: tourId,
        resource_type: 'checklist',
        resource_id: checklistId,
        shared_with_department: department,
        permission: 'view',
        granted_by: session.user.id,
      });
      if (error) { setErrorMessage(error.message); return; }
      logAuditEvent({ tourId, actorId: session.user.id, action: 'share', resourceType: 'resource_share', resourceId: checklistId, detail: { resource_type: 'checklist', shared_with_department: department } });
      const targets = roster.filter((r) => r.department === department).map((r) => r.user_id);
      notify({ tourId, targetUserIds: targets, title: 'Checklist shared with you', body: checklistTitle, data: { type: 'checklist_share', checklistId } });
    }
    await load();
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Sharing</Text>
      <Text style={styles.subtitle}>{checklistTitle}</Text>

      {visibleToAll && (
        <Text style={styles.orgNote}>
          This is already visible to everyone on the tour — specific shares below only matter if it's switched to department-only.
        </Text>
      )}

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <Text style={styles.sectionLabel}>Departments</Text>
      {DEPARTMENTS.map((d) => {
        const checked = shares.some((s) => s.shared_with_department === d);
        return (
          <Pressable key={d} style={styles.checkboxRow} onPress={() => toggleDepartmentShare(d)}>
            <View style={[styles.checkbox, checked && styles.checkboxChecked]}>{checked && <Text style={styles.checkmark}>✓</Text>}</View>
            <Text style={styles.checkboxLabel}>{formatDepartment(d)}</Text>
          </Pressable>
        );
      })}

      <Text style={[styles.sectionLabel, styles.sectionLabelSpaced]}>People</Text>
      {roster.length === 0 && <Text style={styles.emptyText}>No one on the roster yet.</Text>}
      {roster.map((member) => {
        const checked = shares.some((s) => s.shared_with_user_id === member.user_id);
        return (
          <Pressable key={member.user_id} style={styles.checkboxRow} onPress={() => toggleUserShare(member.user_id)}>
            <View style={[styles.checkbox, checked && styles.checkboxChecked]}>{checked && <Text style={styles.checkmark}>✓</Text>}</View>
            <Text style={styles.checkboxLabel}>{member.display_name}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b0f' },
  centered: { flex: 1, backgroundColor: '#0b0b0f', alignItems: 'center', justifyContent: 'center' },
  content: { padding: 20, paddingBottom: 60 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700' },
  subtitle: { color: '#6b6b76', fontSize: 13, marginTop: 4, marginBottom: 16 },
  orgNote: { color: '#e8c274', fontSize: 12, marginBottom: 16, fontStyle: 'italic' },
  error: { color: '#ff6b6b', fontSize: 13, marginBottom: 12 },
  sectionLabel: { color: '#9a9aa5', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', marginBottom: 8 },
  sectionLabelSpaced: { marginTop: 20 },
  emptyText: { color: '#6b6b76', fontSize: 13 },
  checkboxRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#6b6b76',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  checkboxChecked: { backgroundColor: '#7c9cff', borderColor: '#7c9cff' },
  checkmark: { color: '#0b0b0f', fontSize: 13, fontWeight: '700' },
  checkboxLabel: { color: '#fff', fontSize: 15 },
});
