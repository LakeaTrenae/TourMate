/**
 * CalendarScreen — a real month grid for one tour's show dates, distinct
 * from SeasonScreen (which is a cross-tour, year-grouped text timeline of
 * whole TOURS, not individual show dates within one). Monday-start weeks,
 * matching this app's established touring-week convention (lib/dates.ts'
 * getWeekStart). Tapping a day with a show navigates straight to its
 * ShowDetail; days without one are just inert.
 *
 * No calendar library — same "hand-rolled, no dependency" call as
 * lib/csv.ts/lib/ics.ts for something this size (a plain 7-column grid of
 * date math).
 */
import { useCallback, useMemo, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { supabase } from '../lib/supabase';
import { parseDateOnly } from '../lib/dates';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Calendar'>;

type ShowStatus = 'confirmed' | 'hold' | 'cancelled' | 'postponed';
type TourDateRow = {
  id: string;
  date: string;
  show_status: ShowStatus;
  venue: { name: string } | null;
};

const WEEKDAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function statusColor(colors: ThemeColors, status: ShowStatus): string {
  if (status === 'confirmed') return colors.success;
  if (status === 'cancelled') return colors.danger;
  return colors.warn; // hold, postponed
}

function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Monday-start 6-row grid covering the full month plus the leading/
// trailing days needed to complete each week — always 42 cells so the
// grid height never jumps between months.
function buildMonthGrid(year: number, month: number): { date: Date; inMonth: boolean }[] {
  const first = new Date(year, month, 1);
  const firstWeekday = (first.getDay() + 6) % 7; // 0 = Monday
  const start = new Date(year, month, 1 - firstWeekday);
  return Array.from({ length: 42 }, (_, i) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return { date, inMonth: date.getMonth() === month };
  });
}

export function CalendarScreen({ route, navigation }: Props) {
  const { tourId, tourName } = route.params;
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [tourDates, setTourDates] = useState<TourDateRow[]>([]);
  const [cursor, setCursor] = useState<{ year: number; month: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('tour_dates')
      .select('id, date, show_status, venue:venues(name)')
      .eq('tour_id', tourId)
      .order('date', { ascending: true });
    if (error) throw error;
    const rows = (data ?? []) as unknown as TourDateRow[];
    setTourDates(rows);

    // Default to the month of the next upcoming show (today or later); if
    // every show is in the past, default to the most recent one instead
    // of always landing on "now" with nothing visible.
    if (cursor === null) {
      const todayKey = toDateKey(new Date());
      const upcoming = rows.find((r) => r.date >= todayKey);
      const anchor = upcoming ?? rows[rows.length - 1];
      const d = anchor ? parseDateOnly(anchor.date) : new Date();
      setCursor({ year: d.getFullYear(), month: d.getMonth() });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourId]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load()
        .catch((err) => setErrorMessage(err instanceof Error ? err.message : 'Failed to load the calendar.'))
        .finally(() => setLoading(false));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tourId])
  );

  const byDateKey = useMemo(() => {
    const map = new Map<string, TourDateRow[]>();
    for (const row of tourDates) {
      (map.get(row.date) ?? map.set(row.date, []).get(row.date)!).push(row);
    }
    return map;
  }, [tourDates]);

  const grid = useMemo(() => {
    if (!cursor) return [];
    return buildMonthGrid(cursor.year, cursor.month);
  }, [cursor]);

  function shiftMonth(delta: number) {
    setCursor((prev) => {
      if (!prev) return prev;
      const d = new Date(prev.year, prev.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  }

  function handleDayPress(dateKey: string) {
    const shows = byDateKey.get(dateKey);
    if (!shows || shows.length === 0) return;
    navigation.navigate('ShowDetail', { tourId, tourDateId: shows[0].id });
  }

  if (loading || !cursor) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  const monthLabel = new Date(cursor.year, cursor.month, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
  const todayKey = toDateKey(new Date());

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Calendar</Text>
      <Text style={styles.subtitle}>{tourName}</Text>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <View style={styles.monthRow}>
        <Pressable style={styles.chevron} onPress={() => shiftMonth(-1)}>
          <Text style={styles.chevronText}>‹</Text>
        </Pressable>
        <Text style={styles.monthLabel}>{monthLabel}</Text>
        <Pressable style={styles.chevron} onPress={() => shiftMonth(1)}>
          <Text style={styles.chevronText}>›</Text>
        </Pressable>
      </View>

      <View style={styles.weekdayRow}>
        {WEEKDAY_LABELS.map((label, i) => (
          <Text key={i} style={styles.weekdayLabel}>
            {label}
          </Text>
        ))}
      </View>

      <View style={styles.grid}>
        {grid.map(({ date, inMonth }, i) => {
          const dateKey = toDateKey(date);
          const shows = byDateKey.get(dateKey);
          const hasShow = !!shows && shows.length > 0;
          const isToday = dateKey === todayKey;

          return (
            <Pressable
              key={i}
              style={[styles.cell, hasShow && styles.cellWithShow, isToday && styles.cellToday]}
              onPress={() => handleDayPress(dateKey)}
              disabled={!hasShow}
            >
              <Text style={[styles.cellDay, !inMonth && styles.cellDayOutside, hasShow && styles.cellDayActive]}>
                {date.getDate()}
              </Text>
              {hasShow && (
                <View style={styles.dotRow}>
                  {shows!.slice(0, 3).map((s) => (
                    <View key={s.id} style={[styles.dot, { backgroundColor: statusColor(colors, s.show_status) }]} />
                  ))}
                </View>
              )}
            </Pressable>
          );
        })}
      </View>

      <View style={styles.legendRow}>
        <LegendDot colors={colors} styles={styles} color={colors.success} label="Confirmed" />
        <LegendDot colors={colors} styles={styles} color={colors.warn} label="Hold / Postponed" />
        <LegendDot colors={colors} styles={styles} color={colors.danger} label="Cancelled" />
      </View>
    </ScrollView>
  );
}

function LegendDot({
  color,
  label,
  styles,
}: {
  colors: ThemeColors;
  color: string;
  label: string;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={styles.legendLabel}>{label}</Text>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    centered: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
    content: { padding: 20, paddingBottom: 60 },
    title: { color: colors.text, fontSize: 54, fontFamily: fonts.displayBlack, letterSpacing: -1.2 },
    subtitle: { color: colors.textDim, fontSize: 16, marginTop: 2, marginBottom: 16, fontFamily: fonts.body },
    error: { color: colors.danger, fontSize: 16, marginBottom: 12, fontFamily: fonts.body },
    monthRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
    chevron: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: colors.surface2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    chevronText: { color: colors.text, fontSize: 24, fontFamily: fonts.bodyBold },
    monthLabel: { color: colors.text, fontSize: 22, fontFamily: fonts.displaySemiBold },
    weekdayRow: { flexDirection: 'row', marginBottom: 6 },
    weekdayLabel: {
      flex: 1,
      textAlign: 'center',
      color: colors.textFaint,
      fontSize: 14,
      fontFamily: fonts.bodySemiBold,
      textTransform: 'uppercase',
    },
    grid: { flexDirection: 'row', flexWrap: 'wrap' },
    cell: {
      width: '14.28%',
      aspectRatio: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 4,
    },
    cellWithShow: {
      backgroundColor: colors.accentSoft,
      borderRadius: 10,
    },
    cellToday: {
      borderWidth: 1.5,
      borderColor: colors.accent,
      borderRadius: 10,
    },
    cellDay: { color: colors.text, fontSize: 17, fontFamily: fonts.body },
    cellDayOutside: { color: colors.textFaint },
    cellDayActive: { color: colors.text, fontFamily: fonts.bodyBold },
    dotRow: { flexDirection: 'row', gap: 2, marginTop: 3 },
    dot: { width: 4, height: 4, borderRadius: 2 },
    legendRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: 20, justifyContent: 'center' },
    legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    legendLabel: { color: colors.textDim, fontSize: 14, fontFamily: fonts.body },
  });
}
