/**
 * TourExportScreen — "Full Tour Export": every day sheet in one document,
 * a budget summary CSV, a guest list CSV, and a calendar (.ics) file —
 * each its own share-sheet action rather than one bundled archive (no
 * zip capability needed for v1; four separate share actions is simpler
 * and each format already opens correctly in its own dedicated app).
 *
 * Day sheets print directly via expo-print (no file involved — same as
 * before). The three data exports (budget/guest list/calendar) instead
 * upload the generated text to the `tour-exports` Storage bucket and open
 * a signed URL — the exact pattern TourDashboardScreen's calendar export
 * already established, reused here rather than inventing a second way to
 * deliver a generated file.
 *
 * Budget is manager-only (mirrors BudgetScreen's own gate — budget_items
 * has no crew-visible RLS policy at all); day sheets, guest list, and
 * calendar are visible to everyone, matching each of those screens' own
 * visibility.
 *
 * Theme (Manrope/JetBrains Mono, navy accent) per the "Load-In" design
 * review — see lib/theme.tsx.
 */
import { useCallback, useMemo, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Print from 'expo-print';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { formatDateOnly } from '../lib/dates';
import { buildTourExportHtml, type DaySheetData } from '../lib/dayPrint';
import { buildBudgetCsv, buildGuestListCsv } from '../lib/csv';
import { buildTourIcs } from '../lib/ics';
import { newId } from '../lib/ids';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'TourExport'>;

type TourDateRow = {
  id: string;
  date: string;
  load_in: string | null;
  soundcheck: string | null;
  doors: string | null;
  set_time: string | null;
  notes: string | null;
  show_status: string;
  promoter_name: string | null;
  promoter_phone: string | null;
  promoter_email: string | null;
  venue: { name: string; address: string | null; city: string | null; state: string | null } | null;
};

const MANAGER_TIERS = new Set(['owner', 'admin', 'manager']);
type ExportKind = 'daysheets' | 'budget' | 'guestlist' | 'calendar';

export function TourExportScreen({ route }: Props) {
  const { tourId, tourName } = route.params;
  const { session } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [isManager, setIsManager] = useState(false);
  const [dateCount, setDateCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState<ExportKind | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function load() {
    if (!session) return;
    const [{ data: roleData }, { data, error }] = await Promise.all([
      supabase.rpc('effective_tour_role', { p_tour_id: tourId, p_user_id: session.user.id }),
      supabase.from('tour_dates').select('id').eq('tour_id', tourId),
    ]);
    setIsManager(roleData ? MANAGER_TIERS.has(roleData) : false);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    setDateCount((data ?? []).length);
  }

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load().finally(() => setLoading(false));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tourId])
  );

  // Shared delivery for the three generated-text exports — upload to the
  // tour-exports bucket, then hand the signed URL to the OS, same as
  // TourDashboardScreen's own calendar export already does.
  async function deliverFile(text: string, extension: string, contentType: string) {
    const path = `${tourId}/${newId()}.${extension}`;
    const { error: uploadError } = await supabase.storage.from('tour-exports').upload(path, text, { contentType, upsert: true });
    if (uploadError) throw uploadError;
    const { data: signedUrlData, error: signError } = await supabase.storage.from('tour-exports').createSignedUrl(path, 60 * 5);
    if (signError || !signedUrlData) throw signError ?? new Error('Failed to create download link.');
    await Linking.openURL(signedUrlData.signedUrl);
  }

  async function handleExportDaySheets() {
    setErrorMessage(null);
    setExporting('daysheets');
    try {
      const { data, error } = await supabase
        .from('tour_dates')
        .select(
          'date, load_in, soundcheck, doors, set_time, notes, show_status, promoter_name, promoter_phone, promoter_email, venue:venues(name, address, city, state)'
        )
        .eq('tour_id', tourId)
        .order('date', { ascending: true });
      if (error) throw new Error(error.message);

      const rows = (data ?? []) as unknown as TourDateRow[];
      const shows: DaySheetData[] = rows.map((row) => ({
        tourName,
        dateLabel: formatDateOnly(row.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
        showStatus: row.show_status,
        venueName: row.venue?.name ?? null,
        venueAddress: [row.venue?.address, row.venue?.city, row.venue?.state].filter(Boolean).join(', ') || null,
        loadIn: row.load_in,
        soundcheck: row.soundcheck,
        doors: row.doors,
        setTime: row.set_time,
        promoterName: row.promoter_name,
        promoterPhone: row.promoter_phone,
        promoterEmail: row.promoter_email,
        notes: row.notes,
      }));

      await Print.printAsync({ html: buildTourExportHtml(tourName, shows) });
    } catch (err) {
      Alert.alert('Export failed', err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setExporting(null);
    }
  }

  async function handleExportBudget() {
    setErrorMessage(null);
    setExporting('budget');
    try {
      const { data, error } = await supabase
        .from('budget_items')
        .select('category, description, amount, entry_type, deposit_status, tour_date:tour_dates(date)')
        .eq('tour_id', tourId)
        .order('created_at', { ascending: true });
      if (error) throw new Error(error.message);

      const rows = (data ?? []) as unknown as { category: string; description: string | null; amount: number; entry_type: 'income' | 'expense'; deposit_status: string | null; tour_date: { date: string } | null }[];
      if (rows.length === 0) {
        setErrorMessage('No budget entries yet.');
        return;
      }
      const csv = buildBudgetCsv(rows.map((r) => ({ date: r.tour_date?.date ?? null, category: r.category, description: r.description, entry_type: r.entry_type, amount: r.amount, deposit_status: r.deposit_status })));
      await deliverFile(csv, 'csv', 'text/csv');
    } catch (err) {
      Alert.alert('Export failed', err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setExporting(null);
    }
  }

  async function handleExportGuestList() {
    setErrorMessage(null);
    setExporting('guestlist');
    try {
      const { data: dateRows, error: dateError } = await supabase.from('tour_dates').select('id, date').eq('tour_id', tourId);
      if (dateError) throw new Error(dateError.message);
      const dateMap = new Map((dateRows ?? []).map((d) => [d.id, d.date]));
      const dateIds = Array.from(dateMap.keys());
      if (dateIds.length === 0) {
        setErrorMessage('No show dates yet.');
        return;
      }

      const { data, error } = await supabase
        .from('guest_list_requests')
        .select('tour_date_id, guest_name, guest_count, status, notes, requester:profiles(display_name)')
        .in('tour_date_id', dateIds);
      if (error) throw new Error(error.message);

      const rows = (data ?? []) as unknown as { tour_date_id: string; guest_name: string; guest_count: number; status: string; notes: string | null; requester: { display_name: string } | null }[];
      if (rows.length === 0) {
        setErrorMessage('No guest list requests yet.');
        return;
      }
      const csv = buildGuestListCsv(
        rows
          .map((r) => ({ date: dateMap.get(r.tour_date_id) ?? '', guest_name: r.guest_name, guest_count: r.guest_count, status: r.status, requested_by: r.requester?.display_name ?? null, notes: r.notes }))
          .sort((a, b) => a.date.localeCompare(b.date))
      );
      await deliverFile(csv, 'csv', 'text/csv');
    } catch (err) {
      Alert.alert('Export failed', err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setExporting(null);
    }
  }

  async function handleExportCalendar() {
    setErrorMessage(null);
    setExporting('calendar');
    try {
      const { data, error } = await supabase
        .from('tour_dates')
        .select('id, date, load_in, doors, set_time, venue:venues(name, city)')
        .eq('tour_id', tourId)
        .order('date', { ascending: true });
      if (error) throw new Error(error.message);

      const rows = (data ?? []) as unknown as { id: string; date: string; load_in: string | null; doors: string | null; set_time: string | null; venue: { name: string; city: string | null } | null }[];
      if (rows.length === 0) {
        setErrorMessage('No show dates yet.');
        return;
      }
      const shows = rows.map((d) => ({ id: d.id, date: d.date, venueName: d.venue?.name ?? null, city: d.venue?.city ?? null, loadIn: d.load_in, doors: d.doors, setTime: d.set_time }));
      await deliverFile(buildTourIcs(tourName, shows), 'ics', 'text/calendar');
    } catch (err) {
      Alert.alert('Export failed', err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setExporting(null);
    }
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Full Tour Export</Text>
      <Text style={styles.subtitle}>{tourName}</Text>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <ExportCard
        styles={styles}
        colors={colors}
        title="Day Sheets"
        description={
          dateCount === 0
            ? 'No show dates yet — add some from the tour dashboard first.'
            : `Every show date's day sheet (${dateCount} date${dateCount === 1 ? '' : 's'}), one page each, in date order. Opens the print/share sheet.`
        }
        buttonLabel="Export Day Sheets"
        onPress={handleExportDaySheets}
        loading={exporting === 'daysheets'}
        disabled={exporting !== null || dateCount === 0}
      />

      {isManager && (
        <ExportCard
          styles={styles}
          colors={colors}
          title="Budget Summary"
          description="Every income and expense entry as a CSV — opens in Excel, Numbers, or Google Sheets."
          buttonLabel="Export Budget CSV"
          onPress={handleExportBudget}
          loading={exporting === 'budget'}
          disabled={exporting !== null}
        />
      )}

      <ExportCard
        styles={styles}
        colors={colors}
        title="Guest List"
        description="Every guest request across every show date, as a CSV."
        buttonLabel="Export Guest List CSV"
        onPress={handleExportGuestList}
        loading={exporting === 'guestlist'}
        disabled={exporting !== null}
      />

      <ExportCard
        styles={styles}
        colors={colors}
        title="Calendar"
        description="Every show date as a .ics file — import into any calendar app."
        buttonLabel="Export Calendar (.ics)"
        onPress={handleExportCalendar}
        loading={exporting === 'calendar'}
        disabled={exporting !== null}
      />
    </ScrollView>
  );
}

function ExportCard({
  title,
  description,
  buttonLabel,
  onPress,
  loading,
  disabled,
  styles,
  colors,
}: {
  title: string;
  description: string;
  buttonLabel: string;
  onPress: () => void;
  loading: boolean;
  disabled: boolean;
  styles: ReturnType<typeof createStyles>;
  colors: ThemeColors;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      <Text style={styles.cardDescription}>{description}</Text>
      <Pressable style={styles.exportButton} onPress={onPress} disabled={disabled}>
        {loading ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.exportButtonText}>{buttonLabel}</Text>}
      </Pressable>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    centered: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
    content: { padding: 20, paddingBottom: 60 },
    title: { color: colors.text, fontSize: 26, fontFamily: fonts.displayBlack, letterSpacing: -0.4 },
    subtitle: { color: colors.textDim, fontSize: 13, marginTop: 2, marginBottom: 20, fontFamily: fonts.body },
    error: { color: colors.danger, fontSize: 13, marginBottom: 12, fontFamily: fonts.body },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 14,
      padding: 16,
      marginBottom: 14,
      borderWidth: 1,
      borderColor: colors.border,
    },
    cardTitle: { color: colors.text, fontSize: 16, fontFamily: fonts.displaySemiBold, marginBottom: 6 },
    cardDescription: { color: colors.textDim, fontSize: 13, lineHeight: 18, marginBottom: 14, fontFamily: fonts.body },
    exportButton: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
    exportButtonText: { color: colors.onAccent, fontSize: 14, fontFamily: fonts.bodySemiBold },
  });
}
