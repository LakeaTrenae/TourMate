/**
 * SeasonScreen — a chronological timeline of every tour the signed-in
 * user belongs to, across every organization, grouped by year with
 * organization sub-headers within each year. Reuses the exact cross-org
 * `tours` query TourListScreen already runs (RLS does the filtering, see
 * "tours readable by members" in 0001_init.sql) — start_date/end_date are
 * always reliable here since they're auto-computed from tour_dates by
 * the sync_tour_date_range trigger (0016), never manually entered.
 */
import { useCallback, useMemo, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { supabase } from '../lib/supabase';
import { formatDateOnly } from '../lib/dates';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Season'>;

type TourRow = {
  id: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  completed_at: string | null;
  organization: { name: string } | null;
};

export function SeasonScreen({ navigation }: Props) {
  const [tours, setTours] = useState<TourRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function load() {
    const { data, error } = await supabase
      .from('tours')
      .select('id, name, start_date, end_date, completed_at, organization:organizations(name)');
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    setTours((data ?? []) as unknown as TourRow[]);
  }

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load().finally(() => setLoading(false));
    }, [])
  );

  const yearGroups = useMemo(() => {
    // Tours with no dates yet ("TBD") sort last within a synthetic
    // "Unscheduled" bucket rather than crashing the year-grouping logic.
    const withDates = tours.filter((t) => t.start_date);
    const undated = tours.filter((t) => !t.start_date);
    withDates.sort((a, b) => (a.start_date ?? '').localeCompare(b.start_date ?? ''));

    const byYear = new Map<string, TourRow[]>();
    for (const t of withDates) {
      const year = t.start_date!.slice(0, 4);
      (byYear.get(year) ?? byYear.set(year, []).get(year)!).push(t);
    }

    const groups = Array.from(byYear.entries()).map(([year, yearTours]) => {
      const byOrg = new Map<string, TourRow[]>();
      for (const t of yearTours) {
        const orgName = t.organization?.name ?? 'No organization';
        (byOrg.get(orgName) ?? byOrg.set(orgName, []).get(orgName)!).push(t);
      }
      return { year, orgs: Array.from(byOrg.entries()) };
    });

    if (undated.length > 0) {
      const byOrg = new Map<string, TourRow[]>();
      for (const t of undated) {
        const orgName = t.organization?.name ?? 'No organization';
        (byOrg.get(orgName) ?? byOrg.set(orgName, []).get(orgName)!).push(t);
      }
      groups.push({ year: 'Unscheduled', orgs: Array.from(byOrg.entries()) });
    }

    return groups;
  }, [tours]);

  function formatDateRange(start: string | null, end: string | null) {
    if (!start) return 'Dates TBD';
    const startLabel = formatDateOnly(start, { month: 'short', day: 'numeric' });
    if (!end || end === start) return startLabel;
    const endLabel = formatDateOnly(end, { month: 'short', day: 'numeric' });
    return `${startLabel} – ${endLabel}`;
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
      <Text style={styles.title}>Timeline</Text>
      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <ScrollView contentContainerStyle={yearGroups.length === 0 && styles.emptyContainer}>
        {yearGroups.length === 0 ? (
          <Text style={styles.emptyText}>No tours yet.</Text>
        ) : (
          yearGroups.map((group) => (
            <View key={group.year} style={styles.yearGroup}>
              <Text style={styles.yearLabel}>{group.year}</Text>
              {group.orgs.map(([orgName, orgTours]) => (
                <View key={orgName} style={styles.orgGroup}>
                  <Text style={styles.orgLabel}>{orgName}</Text>
                  {orgTours.map((t) => (
                    <Pressable
                      key={t.id}
                      style={styles.card}
                      onPress={() => navigation.navigate('TourDashboard', { tourId: t.id, tourName: t.name })}
                    >
                      <View style={styles.cardHeader}>
                        <Text style={styles.tourName}>{t.name}</Text>
                        {t.completed_at && <Text style={styles.completedBadge}>Completed</Text>}
                      </View>
                      <Text style={styles.tourDates}>{formatDateRange(t.start_date, t.end_date)}</Text>
                    </Pressable>
                  ))}
                </View>
              ))}
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
  title: { color: '#fff', fontSize: 24, fontWeight: '700', marginBottom: 16 },
  error: { color: '#ff6b6b', fontSize: 13, marginBottom: 12 },
  emptyContainer: { flexGrow: 1, justifyContent: 'center' },
  emptyText: { color: '#6b6b76', fontSize: 14, textAlign: 'center' },
  yearGroup: { marginBottom: 20 },
  yearLabel: { color: '#fff', fontSize: 20, fontWeight: '700', marginBottom: 10 },
  orgGroup: { marginBottom: 10 },
  orgLabel: { color: '#9a9aa5', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', marginBottom: 6 },
  card: { backgroundColor: '#1a1a20', borderRadius: 10, padding: 14, marginBottom: 8 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  tourName: { color: '#fff', fontSize: 15, fontWeight: '600' },
  completedBadge: {
    color: '#6b6b76',
    fontSize: 10,
    fontWeight: '600',
    textTransform: 'uppercase',
    backgroundColor: '#0b0b0f',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  tourDates: { color: '#6b6b76', fontSize: 12, marginTop: 4 },
});
