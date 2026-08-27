/**
 * TourListScreen — every tour the signed-in user belongs to.
 *
 * Organized by actual dates, not just the manual "completed" flag: a tour
 * whose end_date has already passed shows as Past even if nobody ever hit
 * "complete" on it, and one whose dates span today shows as In Progress —
 * both are computed client-side from start_date/end_date/completed_at,
 * not separate server state. Search filters by tour or organization name.
 *
 * Notice there's no manual filtering here like `.eq('some_user_id', ...)`
 * — the query just asks for "tours" and Postgres RLS (the
 * "tours readable by members" policy in 0001_init.sql) does the filtering
 * server-side. If this user isn't in `organization_members` or
 * `tour_members` for a given tour, that row never comes back over the
 * wire at all, regardless of what this screen's code does with it.
 */
import { useCallback, useMemo, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { supabase } from '../lib/supabase';
import { formatDateOnly, parseDateOnly } from '../lib/dates';
import { useCachedLoad } from '../lib/useCachedLoad';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'TourList'>;

type TourRow = {
  id: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  completed_at: string | null;
  organization: { name: string } | null;
};

type DateStatus = 'in_progress' | 'upcoming' | 'past';
type FilterMode = 'all' | DateStatus;

const FILTERS: { mode: FilterMode; label: string }[] = [
  { mode: 'all', label: 'All' },
  { mode: 'in_progress', label: 'In Progress' },
  { mode: 'upcoming', label: 'Upcoming' },
  { mode: 'past', label: 'Past' },
];

/**
 * Derived from actual calendar dates, independent of the manual
 * `completed_at` flag — a tour is Past once its dates have elapsed even
 * if no one explicitly marked it complete, and completing it early
 * (mid-tour) always wins regardless of dates.
 */
function dateStatus(tour: TourRow, today: Date): DateStatus {
  if (tour.completed_at) return 'past';
  if (!tour.start_date) return 'upcoming'; // no dates yet — treat as TBD/upcoming
  const start = parseDateOnly(tour.start_date);
  const end = tour.end_date ? parseDateOnly(tour.end_date) : start;
  if (end < today) return 'past';
  if (start <= today) return 'in_progress';
  return 'upcoming';
}

export function TourListScreen({ navigation }: Props) {
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // `organization:organizations(name)` embeds the related org row via the
  // organization_id foreign key — one round trip instead of N+1 queries
  // per tour to look up its org name. Wrapped in useCachedLoad — this is
  // the very first screen after sign-in, so it's one of the two screens
  // (with TourDashboard) where showing last-synced data offline instead
  // of a blank/error screen matters most.
  const fetchTours = useCallback(async () => {
    const { data, error } = await supabase
      .from('tours')
      .select('id, name, start_date, end_date, completed_at, organization:organizations(name)');
    if (error) throw error;
    return (data ?? []) as unknown as TourRow[];
  }, []);

  const { data: toursData, loading, isOffline, refresh } = useCachedLoad('tour-list', fetchTours);
  const tours = toursData ?? [];

  // useFocusEffect (not a plain useEffect) so the list re-fetches every
  // time this screen comes back into focus — e.g. after backing out of a
  // tour dashboard where something may have changed.
  useFocusEffect(
    useCallback(() => {
      refresh().catch((err) => setErrorMessage(err instanceof Error ? err.message : 'Failed to load tours.'));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
  );

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await refresh();
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to load tours.');
    }
    setRefreshing(false);
  }

  /**
   * Tours belong to an organization, so "create a tour" first has to
   * resolve which org it belongs to — routed based on how many the user
   * already has, so the common case (one org) skips straight to naming
   * the tour instead of making everyone pick from a list of one.
   */
  async function handleCreateTour() {
    const { data, error } = await supabase.from('organizations').select('id, name');
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    const orgs = data ?? [];

    if (orgs.length === 0) {
      navigation.navigate('CreateOrganization');
    } else if (orgs.length === 1) {
      navigation.navigate('CreateTour', { organizationId: orgs[0].id });
    } else {
      const buttons: { text: string; onPress?: () => void; style?: 'cancel' }[] = orgs.map((org) => ({
        text: org.name,
        onPress: () => navigation.navigate('CreateTour', { organizationId: org.id }),
      }));
      buttons.push({ text: 'Cancel', style: 'cancel' });
      Alert.alert('Which organization?', 'This tour belongs to:', buttons);
    }
  }

  const sections = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const q = search.trim().toLowerCase();
    const matching = tours.filter(
      (t) => !q || t.name.toLowerCase().includes(q) || t.organization?.name.toLowerCase().includes(q)
    );

    const byStatus: Record<DateStatus, TourRow[]> = { in_progress: [], upcoming: [], past: [] };
    for (const t of matching) byStatus[dateStatus(t, today)].push(t);

    byStatus.upcoming.sort((a, b) => (a.start_date ?? '').localeCompare(b.start_date ?? ''));
    byStatus.in_progress.sort((a, b) => (a.start_date ?? '').localeCompare(b.start_date ?? ''));
    // Most recently finished first — the tour you just wrapped is more
    // relevant right now than one from two years ago.
    byStatus.past.sort((a, b) => (b.end_date ?? b.start_date ?? '').localeCompare(a.end_date ?? a.start_date ?? ''));

    const groups: { status: DateStatus; title: string }[] = [
      { status: 'in_progress', title: 'In Progress' },
      { status: 'upcoming', title: 'Upcoming' },
      { status: 'past', title: 'Past' },
    ];

    return groups
      .filter((g) => filterMode === 'all' || filterMode === g.status)
      .map((g) => ({ title: g.title, data: byStatus[g.status] }))
      .filter((section) => section.data.length > 0);
  }, [tours, search, filterMode]);

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
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Your Tours</Text>
        <View style={styles.headerActions}>
          <Pressable onPress={() => navigation.navigate('Season')}>
            <Text style={styles.signOut}>Timeline</Text>
          </Pressable>
          <Pressable onPress={handleCreateTour}>
            <Text style={styles.createButton}>+ Tour</Text>
          </Pressable>
          <Pressable onPress={() => navigation.navigate('Settings')}>
            <Text style={styles.signOut}>Settings</Text>
          </Pressable>
        </View>
      </View>

      <TextInput
        style={styles.searchInput}
        placeholder="Search tours…"
        placeholderTextColor="#6b6b76"
        value={search}
        onChangeText={setSearch}
      />

      <View style={styles.filterRow}>
        {FILTERS.map((f) => (
          <Pressable
            key={f.mode}
            style={[styles.filterChip, filterMode === f.mode && styles.filterChipActive]}
            onPress={() => setFilterMode(f.mode)}
          >
            <Text style={[styles.filterChipText, filterMode === f.mode && styles.filterChipTextActive]}>
              {f.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {isOffline && <Text style={styles.offlineBanner}>You're offline — showing last synced data.</Text>}
      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#fff" />}
        contentContainerStyle={sections.length === 0 && styles.emptyContainer}
        ListEmptyComponent={
          <Text style={styles.emptyText}>
            {tours.length === 0
              ? 'No tours yet. Once a tour manager adds you, it\'ll show up here — or tap "+ Tour" above to start your own.'
              : 'No tours match this filter.'}
          </Text>
        }
        renderSectionHeader={({ section }) => <Text style={styles.sectionHeader}>{section.title}</Text>}
        renderItem={({ item }) => (
          <Pressable
            style={styles.tourCard}
            onPress={() => navigation.navigate('TourDashboard', { tourId: item.id, tourName: item.name })}
          >
            <View style={styles.tourCardHeader}>
              <Text style={styles.tourName}>{item.name}</Text>
              {item.completed_at && <Text style={styles.completedBadge}>Completed</Text>}
            </View>
            {item.organization && <Text style={styles.orgName}>{item.organization.name}</Text>}
            <Text style={styles.tourDates}>{formatDateRange(item.start_date, item.end_date)}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b0b0f',
    paddingTop: 60,
    paddingHorizontal: 20,
  },
  centered: {
    flex: 1,
    backgroundColor: '#0b0b0f',
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  headerTitle: {
    color: '#fff',
    fontSize: 26,
    fontWeight: '700',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  createButton: {
    color: '#7c9cff',
    fontSize: 14,
    fontWeight: '600',
  },
  signOut: {
    color: '#9a9aa5',
    fontSize: 14,
  },
  searchInput: {
    backgroundColor: '#1a1a20',
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    marginBottom: 12,
  },
  filterRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  filterChip: {
    backgroundColor: '#1a1a20',
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  filterChipActive: {
    backgroundColor: '#fff',
  },
  filterChipText: {
    color: '#9a9aa5',
    fontSize: 12,
    fontWeight: '600',
  },
  filterChipTextActive: {
    color: '#0b0b0f',
  },
  error: {
    color: '#ff6b6b',
    fontSize: 13,
    marginBottom: 12,
  },
  offlineBanner: {
    color: '#e8c274',
    fontSize: 12,
    marginBottom: 12,
    textAlign: 'center',
  },
  emptyContainer: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  emptyText: {
    color: '#6b6b76',
    fontSize: 14,
    textAlign: 'center',
    paddingHorizontal: 20,
  },
  sectionHeader: {
    color: '#6b6b76',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
    marginTop: 12,
  },
  tourCard: {
    backgroundColor: '#1a1a20',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  tourCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  tourName: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  completedBadge: {
    color: '#6b6b76',
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    backgroundColor: '#0b0b0f',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    overflow: 'hidden',
  },
  orgName: {
    color: '#9a9aa5',
    fontSize: 13,
    marginTop: 2,
  },
  tourDates: {
    color: '#6b6b76',
    fontSize: 13,
    marginTop: 6,
  },
});