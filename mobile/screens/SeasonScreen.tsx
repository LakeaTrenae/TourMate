/**
 * SeasonScreen — a chronological timeline of every tour the signed-in
 * user belongs to, across every organization, grouped by year with
 * organization sub-headers within each year. Reuses the exact cross-org
 * `tours` query TourListScreen already runs (RLS does the filtering, see
 * "tours readable by members" in 0001_init.sql) — start_date/end_date are
 * always reliable here since they're auto-computed from tour_dates by
 * the sync_tour_date_range trigger (0016), never manually entered.
 *
 * Grid layout + theme (Manrope/JetBrains Mono, Marquee accent) — see
 * lib/theme.tsx. Cards are TicketCards (same as TourListScreen's own —
 * a tour here is structurally the same record), 2-up via chunkPairs.
 */
import { useCallback, useMemo, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { supabase } from '../lib/supabase';
import { formatDateOnly } from '../lib/dates';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import { TicketCard } from '../components/TicketCard';
import { StampBadge } from '../components/StampBadge';
import type { RootStackParamList } from '../navigation/types';

function chunkPairs<T>(items: T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return rows;
}

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
                  {chunkPairs(orgTours).map((row, i) => (
                    <View key={i} style={styles.row}>
                      {row.map((t) => (
                        <TicketCard
                          key={t.id}
                          style={styles.card}
                          onPress={() => navigation.navigate('TourDashboard', { tourId: t.id, tourName: t.name })}
                          stubRight={t.completed_at ? <StampBadge label="Completed" tone="neutral" /> : undefined}
                        >
                          <Text style={styles.tourName}>{t.name}</Text>
                          <Text style={styles.tourDates}>{formatDateRange(t.start_date, t.end_date)}</Text>
                        </TicketCard>
                      ))}
                      {row.length === 1 && <View style={styles.cardSpacer} />}
                    </View>
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
    title: { color: colors.text, fontSize: 54, fontFamily: fonts.displayBlack, letterSpacing: -1.2, marginBottom: 16 },
    error: { color: colors.danger, fontSize: 16, marginBottom: 12, fontFamily: fonts.body },
    emptyContainer: { flexGrow: 1, justifyContent: 'center' },
    emptyText: { color: colors.textFaint, fontSize: 17, textAlign: 'center', fontFamily: fonts.body },
    yearGroup: { marginBottom: 20 },
    yearLabel: { color: colors.text, fontSize: 24, fontFamily: fonts.displayBold, marginBottom: 10 },
    orgGroup: { marginBottom: 10 },
    orgLabel: { color: colors.textDim, fontSize: 15, fontFamily: fonts.bodySemiBold, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
    row: { flexDirection: 'row', gap: 10, marginBottom: 10 },
    cardSpacer: { flex: 1 },
    card: { flex: 1 },
    tourName: { color: colors.text, fontSize: 18, fontFamily: fonts.displaySemiBold },
    tourDates: { color: colors.textFaint, fontSize: 15, marginTop: 4, fontFamily: fonts.mono },
  });
}
