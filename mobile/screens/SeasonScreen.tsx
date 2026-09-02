/**
 * SeasonScreen — a chronological timeline of every tour the signed-in
 * user belongs to, across every organization, grouped by year with
 * organization sub-headers within each year. Reuses the exact cross-org
 * `tours` query TourListScreen already runs (RLS does the filtering, see
 * "tours readable by members" in 0001_init.sql) — start_date/end_date are
 * always reliable here since they're auto-computed from tour_dates by
 * the sync_tour_date_range trigger (0016), never manually entered.
 *
 * Theme (Manrope/JetBrains Mono, navy accent) per the "Load-In" design
 * review — see lib/theme.tsx.
 */
import { useCallback, useMemo, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { supabase } from '../lib/supabase';
import { formatDateOnly } from '../lib/dates';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
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
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

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
        <ActivityIndicator color={colors.accent} />
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

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg, paddingTop: 20, paddingHorizontal: 20 },
    centered: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
    title: { color: colors.text, fontSize: 26, fontFamily: fonts.displayBlack, letterSpacing: -0.4, marginBottom: 16 },
    error: { color: colors.danger, fontSize: 13, marginBottom: 12, fontFamily: fonts.body },
    emptyContainer: { flexGrow: 1, justifyContent: 'center' },
    emptyText: { color: colors.textFaint, fontSize: 14, textAlign: 'center', fontFamily: fonts.body },
    yearGroup: { marginBottom: 20 },
    yearLabel: { color: colors.text, fontSize: 20, fontFamily: fonts.displayBold, marginBottom: 10 },
    orgGroup: { marginBottom: 10 },
    orgLabel: { color: colors.textDim, fontSize: 12, fontFamily: fonts.bodySemiBold, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 12,
      padding: 14,
      marginBottom: 8,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.08,
      shadowRadius: 10,
      elevation: 2,
    },
    cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    tourName: { color: colors.text, fontSize: 15, fontFamily: fonts.displaySemiBold },
    completedBadge: {
      color: colors.textFaint,
      fontSize: 10,
      fontFamily: fonts.bodySemiBold,
      textTransform: 'uppercase',
      backgroundColor: colors.surface2,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
    },
    tourDates: { color: colors.textFaint, fontSize: 12, marginTop: 4, fontFamily: fonts.mono },
  });
}
