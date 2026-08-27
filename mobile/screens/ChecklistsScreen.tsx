/**
 * ChecklistsScreen — list of this tour's checklists (venue walkthrough,
 * hospitality & rider notes, or anything else a department wants to
 * track as checkable items + a running notes field). Generic on purpose:
 * one feature backs every checklist instead of a separate screen per use
 * case (see 0021_security_hospitality_checklists.sql for the schema/RLS
 * this mirrors from schedule_items).
 */
import { useCallback, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { formatDepartment } from '../lib/format';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Checklists'>;

type Checklist = {
  id: string;
  title: string;
  department: string;
  visible_to_all: boolean;
  item_count: number;
  checked_count: number;
};

const MANAGER_TIERS = new Set(['owner', 'admin', 'manager']);

export function ChecklistsScreen({ route, navigation }: Props) {
  const { tourId, tourName } = route.params;
  const { session } = useAuth();

  const [isManager, setIsManager] = useState(false);
  const [ownDepartment, setOwnDepartment] = useState<string | null>(null);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function load() {
    if (!session) return;

    const { data: roleData } = await supabase.rpc('effective_tour_role', {
      p_tour_id: tourId,
      p_user_id: session.user.id,
    });
    setIsManager(roleData ? MANAGER_TIERS.has(roleData) : false);

    const { data: ownMembership } = await supabase
      .from('tour_members')
      .select('department')
      .eq('tour_id', tourId)
      .eq('user_id', session.user.id)
      .maybeSingle();
    setOwnDepartment(ownMembership?.department ?? null);

    // RLS ("checklists readable per visibility rules") already returns
    // only what this user can see — no client-side filtering needed.
    const { data: checklistRows, error: checklistError } = await supabase
      .from('checklists')
      .select('id, title, department, visible_to_all')
      .eq('tour_id', tourId)
      .order('created_at', { ascending: false });
    if (checklistError) {
      setErrorMessage(checklistError.message);
      return;
    }

    const ids = (checklistRows ?? []).map((c) => c.id);
    let counts: Record<string, { total: number; checked: number }> = {};
    if (ids.length > 0) {
      const { data: itemRows, error: itemError } = await supabase
        .from('checklist_items')
        .select('checklist_id, is_checked')
        .in('checklist_id', ids);
      if (itemError) {
        setErrorMessage(itemError.message);
        return;
      }
      counts = {};
      for (const item of itemRows ?? []) {
        const bucket = (counts[item.checklist_id] ??= { total: 0, checked: 0 });
        bucket.total += 1;
        if (item.is_checked) bucket.checked += 1;
      }
    }

    setChecklists(
      (checklistRows ?? []).map((c) => ({
        ...c,
        item_count: counts[c.id]?.total ?? 0,
        checked_count: counts[c.id]?.checked ?? 0,
      }))
    );
  }

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load().finally(() => setLoading(false));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tourId])
  );

  async function handleRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  // Client-side approximation of can_edit_checklist, for deciding whether
  // to show the delete hint at all — RLS is the actual enforcement, this
  // just avoids offering an action that would only fail.
  function canEdit(checklist: Checklist) {
    return isManager || ownDepartment === checklist.department;
  }

  function confirmDelete(checklist: Checklist) {
    Alert.alert('Delete this checklist?', checklist.title, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('checklists').delete().eq('id', checklist.id);
          if (error) setErrorMessage(error.message);
          else await load();
        },
      },
    ]);
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Checklists</Text>
          <Text style={styles.subtitle}>{tourName}</Text>
        </View>
        <Pressable style={styles.addButton} onPress={() => navigation.navigate('AddChecklist', { tourId })}>
          <Text style={styles.addButtonText}>+ New</Text>
        </Pressable>
      </View>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#fff" />}
        contentContainerStyle={checklists.length === 0 && styles.emptyContainer}
      >
        {checklists.length === 0 ? (
          <Text style={styles.emptyText}>
            No checklists yet — venue walkthrough, hospitality & rider notes, load-in, whatever your team needs to
            track.
          </Text>
        ) : (
          checklists.map((c) => (
            <Pressable
              key={c.id}
              style={styles.card}
              onPress={() => navigation.navigate('ChecklistDetail', { checklistId: c.id, tourId, title: c.title })}
              onLongPress={canEdit(c) ? () => confirmDelete(c) : undefined}
            >
              <View>
                <Text style={styles.checklistTitle}>{c.title}</Text>
                <Text style={styles.checklistMeta}>
                  {formatDepartment(c.department)}
                  {!c.visible_to_all ? ' · Department only' : ''}
                  {c.item_count > 0 ? ` · ${c.checked_count}/${c.item_count} done` : ' · No items yet'}
                </Text>
              </View>
              <Text style={styles.openArrow}>›</Text>
            </Pressable>
          ))
        )}
        {checklists.length > 0 && <Text style={styles.hint}>Hold a checklist to delete it.</Text>}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b0f', paddingTop: 20, paddingHorizontal: 20 },
  centered: { flex: 1, backgroundColor: '#0b0b0f', alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 },
  title: { color: '#fff', fontSize: 24, fontWeight: '700' },
  subtitle: { color: '#6b6b76', fontSize: 13, marginTop: 2 },
  addButton: { backgroundColor: '#fff', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  addButtonText: { color: '#0b0b0f', fontSize: 13, fontWeight: '600' },
  error: { color: '#ff6b6b', fontSize: 13, marginBottom: 12 },
  emptyContainer: { flexGrow: 1, justifyContent: 'center' },
  emptyText: { color: '#6b6b76', fontSize: 14, textAlign: 'center', paddingHorizontal: 10 },
  card: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#1a1a20',
    borderRadius: 12,
    padding: 16,
    marginBottom: 10,
  },
  checklistTitle: { color: '#fff', fontSize: 15, fontWeight: '600' },
  checklistMeta: { color: '#6b6b76', fontSize: 12, marginTop: 4 },
  openArrow: { color: '#6b6b76', fontSize: 18 },
  hint: { color: '#6b6b76', fontSize: 12, textAlign: 'center', marginTop: 8 },
});
