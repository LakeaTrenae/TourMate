/**
 * GuestListScreen — guest requests grouped by show date.
 *
 * Unlike Travel/Lodging, submitting a request isn't manager-only — any
 * tour member can add one (see "guest_list insertable by members" in
 * 0001_init.sql, matching how Master Tour lets artists send their own
 * guest list requests directly). Approving/denying, though, is
 * manager-only — both in the UI (buttons hidden for non-managers) and in
 * RLS ("guest_list updatable by managers", 0002_policy_gaps.sql).
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
import { formatDateOnly } from '../lib/dates';
import { notify } from '../lib/notify';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'GuestList'>;

type TourDate = { id: string; date: string; capacity_override: number | null; venue: { capacity: number | null } | null };
type GuestRequest = {
  id: string;
  tour_date_id: string;
  guest_name: string;
  guest_count: number;
  status: 'pending' | 'approved' | 'denied';
  notes: string | null;
  requested_by: string;
  requester: { display_name: string } | null;
};

const MANAGER_TIERS = new Set(['owner', 'admin', 'manager']);

export function GuestListScreen({ route, navigation }: Props) {
  const { tourId, tourName } = route.params;
  const { session } = useAuth();

  const [isManager, setIsManager] = useState(false);
  const [dates, setDates] = useState<TourDate[]>([]);
  const [requestsByDate, setRequestsByDate] = useState<Record<string, GuestRequest[]>>({});
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

    const { data: dateRows, error: dateError } = await supabase
      .from('tour_dates')
      .select('id, date, capacity_override, venue:venues(capacity)')
      .eq('tour_id', tourId)
      .order('date', { ascending: true });
    if (dateError) {
      setErrorMessage(dateError.message);
      return;
    }
    setDates((dateRows ?? []) as unknown as TourDate[]);

    const dateIds = (dateRows ?? []).map((d) => d.id);
    if (dateIds.length === 0) {
      setRequestsByDate({});
      return;
    }
    const { data: requestRows, error: requestError } = await supabase
      .from('guest_list_requests')
      .select('id, tour_date_id, guest_name, guest_count, status, notes, requested_by, requester:profiles(display_name)')
      .in('tour_date_id', dateIds)
      .order('created_at', { ascending: false });
    if (requestError) {
      setErrorMessage(requestError.message);
      return;
    }
    const grouped: Record<string, GuestRequest[]> = {};
    for (const row of (requestRows ?? []) as unknown as GuestRequest[]) {
      (grouped[row.tour_date_id] ??= []).push(row);
    }
    setRequestsByDate(grouped);
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

  async function updateStatus(request: GuestRequest, status: 'approved' | 'denied') {
    const { error } = await supabase.from('guest_list_requests').update({ status }).eq('id', request.id);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    notify({
      tourId,
      targetUserIds: [request.requested_by],
      title: status === 'approved' ? 'Guest request approved' : 'Guest request denied',
      body: request.guest_name,
      data: { type: 'guest_list_status', requestId: request.id, status },
    });
    await load();
  }

  function formatDate(dateStr: string) {
    return formatDateOnly(dateStr, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  // Approaching/over capacity is judged against approved guests only —
  // pending requests haven't actually been let in yet, so counting them
  // would flag a date as over capacity before anyone actually said yes.
  function capacityWarning(date: TourDate): string | null {
    const capacity = date.capacity_override ?? date.venue?.capacity ?? null;
    if (!capacity) return null;
    const approvedCount = (requestsByDate[date.id] ?? [])
      .filter((r) => r.status === 'approved')
      .reduce((sum, r) => sum + r.guest_count, 0);
    if (approvedCount >= capacity) return `${approvedCount} / ${capacity} approved — at or over capacity`;
    if (approvedCount >= capacity * 0.9) return `${approvedCount} / ${capacity} approved — approaching capacity`;
    return null;
  }

  // Deletion is manager-only, matching the RLS policy ("guest_list
  // deletable by managers" in 0014_missing_delete_policies.sql) — a
  // requester can't delete their own pending request from here, only
  // wait for a manager to approve/deny it.
  function confirmDelete(request: GuestRequest) {
    Alert.alert('Delete this request?', request.guest_name, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('guest_list_requests').delete().eq('id', request.id);
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
          <Text style={styles.title}>Guest List</Text>
          <Text style={styles.subtitle}>{tourName}</Text>
        </View>
        <Pressable
          style={styles.addButton}
          onPress={() => navigation.navigate('AddGuestRequest', { tourId })}
          disabled={dates.length === 0}
        >
          <Text style={styles.addButtonText}>+ Request</Text>
        </Pressable>
      </View>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#fff" />}
        contentContainerStyle={dates.length === 0 && styles.emptyContainer}
      >
        {dates.length === 0 ? (
          <Text style={styles.emptyText}>No show dates yet — add one from the tour dashboard first.</Text>
        ) : (
          dates.map((d) => {
            const requests = requestsByDate[d.id] ?? [];
            const warning = capacityWarning(d);
            return (
              <View key={d.id} style={styles.dateGroup}>
                <Text style={styles.dateLabel}>{formatDate(d.date)}</Text>
                {warning && <Text style={styles.capacityWarning}>{warning}</Text>}
                {requests.length === 0 ? (
                  <Text style={styles.emptyText}>No requests for this date.</Text>
                ) : (
                  requests.map((r) => (
                    <Pressable
                      key={r.id}
                      style={styles.card}
                      onLongPress={isManager ? () => confirmDelete(r) : undefined}
                    >
                      <View style={styles.cardHeader}>
                        <Text style={styles.guestName}>
                          {r.guest_name} {r.guest_count > 1 ? `(+${r.guest_count - 1})` : ''}
                        </Text>
                        <Text style={[styles.statusBadge, statusStyle(r.status)]}>{r.status}</Text>
                      </View>
                      <Text style={styles.requester}>Requested by {r.requester?.display_name ?? 'Unknown'}</Text>
                      {r.notes && <Text style={styles.notes}>{r.notes}</Text>}
                      {isManager ? (
                        <View style={styles.actions}>
                          {r.status === 'pending' && (
                            <>
                              <Pressable style={styles.approveButton} onPress={() => updateStatus(r, 'approved')}>
                                <Text style={styles.approveButtonText}>Approve</Text>
                              </Pressable>
                              <Pressable style={styles.denyButton} onPress={() => updateStatus(r, 'denied')}>
                                <Text style={styles.denyButtonText}>Deny</Text>
                              </Pressable>
                            </>
                          )}
                          <Pressable style={styles.deleteButton} onPress={() => confirmDelete(r)}>
                            <Text style={styles.deleteButtonText}>Delete</Text>
                          </Pressable>
                        </View>
                      ) : null}
                    </Pressable>
                  ))
                )}
              </View>
            );
          })
        )}
        {isManager && dates.length > 0 && <Text style={styles.hint}>Tap Delete (or hold a request) to remove it.</Text>}
      </ScrollView>
    </View>
  );
}

function statusStyle(status: string) {
  if (status === 'approved') return { color: '#7ee787' };
  if (status === 'denied') return { color: '#ff6b6b' };
  return { color: '#e8c274' };
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
  emptyText: { color: '#6b6b76', fontSize: 13, textAlign: 'center' },
  dateGroup: { marginBottom: 18 },
  dateLabel: { color: '#9a9aa5', fontSize: 13, fontWeight: '600', marginBottom: 8 },
  capacityWarning: { color: '#e8c274', fontSize: 12, fontWeight: '600', marginBottom: 8 },
  card: { backgroundColor: '#1a1a20', borderRadius: 12, padding: 14, marginBottom: 8 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  guestName: { color: '#fff', fontSize: 15, fontWeight: '600' },
  statusBadge: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  requester: { color: '#6b6b76', fontSize: 12, marginTop: 4 },
  notes: { color: '#9a9aa5', fontSize: 13, marginTop: 6 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  approveButton: { backgroundColor: '#1e3a24', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  approveButtonText: { color: '#7ee787', fontSize: 12, fontWeight: '600' },
  denyButton: { backgroundColor: '#3a1e1e', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  denyButtonText: { color: '#ff6b6b', fontSize: 12, fontWeight: '600' },
  deleteButton: { backgroundColor: '#2a2a32', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  deleteButtonText: { color: '#9a9aa5', fontSize: 12, fontWeight: '600' },
  hint: { color: '#6b6b76', fontSize: 12, textAlign: 'center', marginTop: 4 },
});