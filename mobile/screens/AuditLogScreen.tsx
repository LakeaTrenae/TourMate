/**
 * AuditLogScreen — who changed what, when. Manager-only (RLS: "audit_log
 * readable by managers", 0031), reverse-chronological, filterable by
 * resource type. Read-only — there's no edit/delete UI for audit log
 * rows on purpose (append-only at the RLS layer too, see 0031).
 */
import { useCallback, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { supabase } from '../lib/supabase';
import type { RootStackParamList } from '../navigation/types';
import type { AuditAction, AuditResourceType } from '../lib/auditLog';

type Props = NativeStackScreenProps<RootStackParamList, 'AuditLog'>;

type LogEntry = {
  id: string;
  actor_id: string | null;
  action: AuditAction;
  resource_type: AuditResourceType;
  resource_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
  actor: { display_name: string } | null;
};

const RESOURCE_TYPE_LABELS: Record<AuditResourceType, string> = {
  budget_item: 'Budget',
  settlement: 'Settlement',
  tour_member: 'Team',
  artist_contact: 'Artist Contact',
  resource_share: 'Sharing',
};
const RESOURCE_TYPES = Object.keys(RESOURCE_TYPE_LABELS) as AuditResourceType[];

const ACTION_LABELS: Record<AuditAction, string> = {
  create: 'Created',
  update: 'Updated',
  delete: 'Deleted',
  share: 'Shared',
  unshare: 'Unshared',
  approve: 'Approved',
  deny: 'Denied',
};

export function AuditLogScreen({ route }: Props) {
  const { tourId, tourName } = route.params;

  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [activeType, setActiveType] = useState<AuditResourceType | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function load() {
    const { data, error } = await supabase
      .from('audit_log')
      .select('id, actor_id, action, resource_type, resource_id, detail, created_at, actor:profiles(display_name)')
      .eq('tour_id', tourId)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    setEntries((data ?? []) as unknown as LogEntry[]);
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

  const presentTypes = RESOURCE_TYPES.filter((t) => entries.some((e) => e.resource_type === t));
  const filtered = activeType ? entries.filter((e) => e.resource_type === activeType) : entries;

  function describeDetail(entry: LogEntry): string | null {
    const d = entry.detail;
    if (!d) return null;
    const parts = Object.entries(d)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`);
    return parts.length > 0 ? parts.join(' · ') : null;
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
        <Text style={styles.title}>Activity Log</Text>
        <Text style={styles.subtitle}>{tourName}</Text>
      </View>

      {(presentTypes.length > 1 || activeType) && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow} contentContainerStyle={styles.chipRowContent}>
          <Pressable style={[styles.chip, activeType === null && styles.chipActive]} onPress={() => setActiveType(null)}>
            <Text style={[styles.chipText, activeType === null && styles.chipTextActive]}>All</Text>
          </Pressable>
          {presentTypes.map((t) => (
            <Pressable key={t} style={[styles.chip, activeType === t && styles.chipActive]} onPress={() => setActiveType(t)}>
              <Text style={[styles.chipText, activeType === t && styles.chipTextActive]}>{RESOURCE_TYPE_LABELS[t]}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#fff" />}
        contentContainerStyle={filtered.length === 0 && styles.emptyContainer}
      >
        {filtered.length === 0 ? (
          <Text style={styles.emptyText}>Nothing logged yet.</Text>
        ) : (
          filtered.map((entry) => (
            <View key={entry.id} style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.action}>
                  {ACTION_LABELS[entry.action]} {RESOURCE_TYPE_LABELS[entry.resource_type]}
                </Text>
                <Text style={styles.timestamp}>
                  {new Date(entry.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                </Text>
              </View>
              <Text style={styles.actor}>{entry.actor?.display_name ?? 'Unknown'}</Text>
              {describeDetail(entry) && <Text style={styles.detail}>{describeDetail(entry)}</Text>}
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b0f', paddingTop: 20, paddingHorizontal: 20 },
  centered: { flex: 1, backgroundColor: '#0b0b0f', alignItems: 'center', justifyContent: 'center' },
  header: { marginBottom: 16 },
  title: { color: '#fff', fontSize: 24, fontWeight: '700' },
  subtitle: { color: '#6b6b76', fontSize: 13, marginTop: 2 },
  chipRow: { flexGrow: 0, marginBottom: 12 },
  chipRowContent: { gap: 8, paddingRight: 8 },
  chip: { backgroundColor: '#1a1a20', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 7 },
  chipActive: { backgroundColor: '#fff' },
  chipText: { color: '#9a9aa5', fontSize: 12, fontWeight: '600' },
  chipTextActive: { color: '#0b0b0f' },
  error: { color: '#ff6b6b', fontSize: 13, marginBottom: 12 },
  emptyContainer: { flexGrow: 1, justifyContent: 'center' },
  emptyText: { color: '#6b6b76', fontSize: 14, textAlign: 'center' },
  card: { backgroundColor: '#1a1a20', borderRadius: 10, padding: 14, marginBottom: 8 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  action: { color: '#fff', fontSize: 14, fontWeight: '600' },
  timestamp: { color: '#6b6b76', fontSize: 11 },
  actor: { color: '#9a9aa5', fontSize: 12, marginTop: 4 },
  detail: { color: '#6b6b76', fontSize: 12, marginTop: 4 },
});
