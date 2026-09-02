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
 *
 * Grid layout + theme (Fraunces/Manrope/JetBrains Mono, navy accent) per
 * the "Load-In" design review — see lib/theme.tsx. SectionList has no
 * numColumns option (that's FlatList-only), so each section's tours are
 * pre-chunked into pairs and rendered as rows of up to two cards.
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
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'TourList'>;

type TourRow = {
  id: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  completed_at: string | null;
  organization: { id: string; name: string } | null;
};

type LockedOrg = { id: string; name: string };

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

function chunkPairs<T>(items: T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return rows;
}

export function TourListScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lockedOrgs, setLockedOrgs] = useState<LockedOrg[]>([]);

  // `organization:organizations(name)` embeds the related org row via the
  // organization_id foreign key — one round trip instead of N+1 queries
  // per tour to look up its org name. Wrapped in useCachedLoad — this is
  // the very first screen after sign-in, so it's one of the two screens
  // (with TourDashboard) where showing last-synced data offline instead
  // of a blank/error screen matters most.
  const fetchTours = useCallback(async () => {
    const { data, error } = await supabase
      .from('tours')
      .select('id, name, start_date, end_date, completed_at, organization:organizations(id, name)');
    if (error) throw error;
    return (data ?? []) as unknown as TourRow[];
  }, []);

  const { data: toursData, loading, isOffline, refresh } = useCachedLoad('tour-list', fetchTours);
  const tours = toursData ?? [];

  // useFocusEffect (not a plain useEffect) so the list re-fetches every
  // time this screen comes back into focus — e.g. after backing out of a
  // tour dashboard where something may have changed.
  // Deliberately NOT a plain `organizations`/`organization_members`
  // select — organization_members only ever contains the org creator
  // (confirmed directly against live data: a crew member invited via
  // tour_invites/tour_members never gets a row there), and tour_members
  // itself IS gated by the billing lock (0034's effective_tour_role
  // patch). A crew-only member would have no readable table left to
  // learn their org is locked from — exactly the "tours silently
  // vanish, no explanation" problem this banner exists to prevent. The
  // my_organizations_billing_status RPC (0035) is deliberately NOT
  // billing-gated for this exact reason: its whole purpose is to keep
  // working once org_billing_active is false.
  const fetchLockedOrgs = useCallback(async () => {
    const { data, error } = await supabase.rpc('my_organizations_billing_status');
    if (error) return; // best-effort — the tours query above still works either way
    const now = Date.now();
    const locked = ((data ?? []) as {
      organization_id: string;
      organization_name: string;
      subscription_status: string;
      trial_ends_at: string | null;
    }[]).filter((org) => {
      if (org.subscription_status === 'active') return false;
      if (org.subscription_status === 'trialing' && org.trial_ends_at && new Date(org.trial_ends_at).getTime() > now) {
        return false;
      }
      return true; // past_due, canceled, none, or an expired trial
    });
    setLockedOrgs(locked.map((org) => ({ id: org.organization_id, name: org.organization_name })));
  }, []);

  useFocusEffect(
    useCallback(() => {
      refresh().catch((err) => setErrorMessage(err instanceof Error ? err.message : 'Failed to load tours.'));
      fetchLockedOrgs();
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
      .map((g) => ({ title: g.title, status: g.status, data: chunkPairs(byStatus[g.status]) }))
      .filter((section) => section.data.length > 0);
  }, [tours, search, filterMode]);

  function formatDateRange(start: string | null, end: string | null) {
    if (!start) return 'Dates TBD';
    const startLabel = formatDateOnly(start, { month: 'short', day: 'numeric' });
    if (!end || end === start) return startLabel;
    const endLabel = formatDateOnly(end, { month: 'short', day: 'numeric' });
    return `${startLabel} – ${endLabel}`;
  }

  function renderTourCard(item: TourRow, status: DateStatus) {
    const isActive = status === 'in_progress';
    const isUpcoming = status === 'upcoming';
    const statusColor = isActive || isUpcoming ? colors.accent : colors.textFaint;
    const statusLabel = isActive ? 'Active' : isUpcoming ? 'Upcoming' : 'Completed';

    return (
      <Pressable
        key={item.id}
        style={[styles.tourCard, isActive && styles.tourCardActive]}
        onPress={() => navigation.navigate('TourDashboard', { tourId: item.id, tourName: item.name })}
      >
        <View style={styles.statusRow}>
          <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
          <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
        </View>
        {item.organization && <Text style={styles.eyebrow}>{item.organization.name.toUpperCase()}</Text>}
        <Text style={styles.tourName}>{item.name}</Text>
        <Text style={styles.tourDates}>{formatDateRange(item.start_date, item.end_date)}</Text>
      </Pressable>
    );
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Your Tours</Text>
        <View style={styles.headerActions}>
          <Pressable onPress={() => navigation.navigate('Season')}>
            <Text style={styles.headerLink}>Timeline</Text>
          </Pressable>
          <Pressable onPress={handleCreateTour}>
            <Text style={styles.createButton}>+ Tour</Text>
          </Pressable>
          <Pressable onPress={() => navigation.navigate('Settings')}>
            <Text style={styles.headerLink}>Settings</Text>
          </Pressable>
        </View>
      </View>

      <TextInput
        style={styles.searchInput}
        placeholder="Search tours…"
        placeholderTextColor={colors.textFaint}
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

      {lockedOrgs.map((org) => (
        <Pressable
          key={org.id}
          style={styles.lockedOrgBanner}
          onPress={() => navigation.navigate('Billing', { organizationId: org.id, organizationName: org.name })}
        >
          <Text style={styles.lockedOrgText}>🔒 Billing needed for {org.name}</Text>
          <Text style={styles.lockedOrgArrow}>›</Text>
        </Pressable>
      ))}

      <SectionList
        sections={sections}
        keyExtractor={(row, index) => row.map((t) => t.id).join('-') || `empty-${index}`}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.accent} />}
        contentContainerStyle={sections.length === 0 && styles.emptyContainer}
        ListEmptyComponent={
          <Text style={styles.emptyText}>
            {tours.length === 0
              ? 'No tours yet. Once a tour manager adds you, it\'ll show up here — or tap "+ Tour" above to start your own.'
              : 'No tours match this filter.'}
          </Text>
        }
        renderSectionHeader={({ section }) => <Text style={styles.sectionHeader}>{section.title}</Text>}
        renderItem={({ item, section }) => (
          <View style={styles.row}>
            {item.map((tour) => renderTourCard(tour, section.status))}
            {item.length === 1 && <View style={styles.rowSpacer} />}
          </View>
        )}
      />
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.bg,
      paddingTop: 60,
      paddingHorizontal: 20,
    },
    centered: {
      flex: 1,
      backgroundColor: colors.bg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 18,
    },
    headerTitle: {
      color: colors.text,
      fontSize: 28,
      fontFamily: fonts.displayBlack,
      letterSpacing: -0.5,
    },
    headerActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
    },
    createButton: {
      color: colors.accent,
      fontSize: 14,
      fontFamily: fonts.bodySemiBold,
    },
    headerLink: {
      color: colors.textDim,
      fontSize: 14,
      fontFamily: fonts.bodyMedium,
    },
    searchInput: {
      backgroundColor: colors.surface,
      color: colors.text,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
      fontSize: 14,
      fontFamily: fonts.body,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: colors.border,
    },
    filterRow: {
      flexDirection: 'row',
      gap: 8,
      marginBottom: 16,
    },
    filterChip: {
      backgroundColor: colors.surface2,
      borderRadius: 16,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    filterChipActive: {
      backgroundColor: colors.accent,
    },
    filterChipText: {
      color: colors.textDim,
      fontSize: 12,
      fontFamily: fonts.bodySemiBold,
    },
    filterChipTextActive: {
      color: colors.onAccent,
    },
    error: {
      color: colors.danger,
      fontSize: 13,
      marginBottom: 12,
      fontFamily: fonts.body,
    },
    offlineBanner: {
      color: colors.warn,
      fontSize: 12,
      marginBottom: 12,
      textAlign: 'center',
      fontFamily: fonts.body,
    },
    lockedOrgBanner: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      backgroundColor: colors.warnSoft,
      borderWidth: 1,
      borderColor: colors.warn,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      marginBottom: 12,
    },
    lockedOrgText: {
      color: colors.warn,
      fontSize: 14,
      fontFamily: fonts.bodySemiBold,
      flex: 1,
    },
    lockedOrgArrow: {
      color: colors.warn,
      fontSize: 18,
    },
    emptyContainer: {
      flexGrow: 1,
      justifyContent: 'center',
    },
    emptyText: {
      color: colors.textFaint,
      fontSize: 14,
      textAlign: 'center',
      paddingHorizontal: 20,
      fontFamily: fonts.body,
    },
    sectionHeader: {
      color: colors.textDim,
      fontSize: 11,
      fontFamily: fonts.bodySemiBold,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
      marginBottom: 10,
      marginTop: 14,
    },
    row: {
      flexDirection: 'row',
      gap: 10,
      marginBottom: 10,
    },
    rowSpacer: {
      flex: 1,
    },
    tourCard: {
      flex: 1,
      backgroundColor: colors.surface,
      borderRadius: 14,
      padding: 14,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.08,
      shadowRadius: 10,
      elevation: 2,
    },
    tourCardActive: {
      borderTopWidth: 2,
      borderTopColor: colors.accent,
      paddingTop: 12,
    },
    statusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      marginBottom: 8,
    },
    statusDot: {
      width: 5,
      height: 5,
      borderRadius: 3,
    },
    statusText: {
      fontSize: 9,
      fontFamily: fonts.bodySemiBold,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    eyebrow: {
      color: colors.textDim,
      fontSize: 9,
      fontFamily: fonts.mono,
      letterSpacing: 0.4,
      marginBottom: 6,
    },
    tourName: {
      color: colors.text,
      fontSize: 16,
      fontFamily: fonts.displaySemiBold,
      marginBottom: 6,
      lineHeight: 19,
    },
    tourDates: {
      color: colors.textDim,
      fontSize: 11,
      fontFamily: fonts.mono,
    },
  });
}
