/**
 * TourExportScreen — one button, one action: print (or save-as-PDF via
 * the OS share sheet) every show date's day sheet in one document, date
 * order, one page per date. Same `Print.printAsync({ html })` mechanism
 * as ShowDetailScreen's single-day print — no manager gate, since the
 * single-day version isn't gated either (promoter/schedule info visible
 * there is already visible to whoever can open that date's detail screen).
 */
import { useCallback, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Print from 'expo-print';

import { supabase } from '../lib/supabase';
import { formatDateOnly } from '../lib/dates';
import { buildTourExportHtml, type DaySheetData } from '../lib/dayPrint';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'TourExport'>;

type TourDateRow = {
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

export function TourExportScreen({ route }: Props) {
  const { tourId, tourName } = route.params;

  const [dateCount, setDateCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [printing, setPrinting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function load() {
    const { data, error } = await supabase
      .from('tour_dates')
      .select('id')
      .eq('tour_id', tourId);
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

  async function handleExport() {
    setErrorMessage(null);
    setPrinting(true);
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
      setPrinting(false);
    }
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
      <Text style={styles.title}>Full Tour Export</Text>
      <Text style={styles.subtitle}>{tourName}</Text>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <Text style={styles.description}>
        {dateCount === 0
          ? 'No show dates yet — add some from the tour dashboard first.'
          : `Builds a single document with every show date's day sheet (${dateCount} date${dateCount === 1 ? '' : 's'}), one page each, in date order. Opens the OS print/share sheet — save as PDF, AirDrop, email, etc.`}
      </Text>

      <Pressable style={styles.exportButton} onPress={handleExport} disabled={printing || dateCount === 0}>
        {printing ? <ActivityIndicator color="#0b0b0f" /> : <Text style={styles.exportButtonText}>Export Full Tour Sheet</Text>}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b0f', paddingTop: 20, paddingHorizontal: 20 },
  centered: { flex: 1, backgroundColor: '#0b0b0f', alignItems: 'center', justifyContent: 'center' },
  title: { color: '#fff', fontSize: 24, fontWeight: '700' },
  subtitle: { color: '#6b6b76', fontSize: 13, marginTop: 2, marginBottom: 20 },
  error: { color: '#ff6b6b', fontSize: 13, marginBottom: 12 },
  description: { color: '#9a9aa5', fontSize: 14, lineHeight: 20, marginBottom: 24 },
  exportButton: { backgroundColor: '#fff', borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  exportButtonText: { color: '#0b0b0f', fontSize: 15, fontWeight: '600' },
});
