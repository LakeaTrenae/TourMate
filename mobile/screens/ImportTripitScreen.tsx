/**
 * ImportTripitScreen — pull flights and lodging from the manager's own
 * TripIt feed (pasted into Settings once), review/edit every row, then
 * commit. Same idle → extracting → review → importing phase machine as
 * ImportScheduleScreen, same "nothing writes until you confirm"
 * guarantee — the extraction (supabase/functions/extract-tripit) is a
 * starting point, not a commit, exactly like the schedule importer.
 *
 * Deliberately doesn't assign flight passengers or lodging room
 * occupants here — that's a manual follow-up on TravelScreen/
 * LodgingScreen, same as a manually-added flight/room starts unassigned.
 *
 * Theme (Manrope/JetBrains Mono, navy accent) per the "Load-In" design
 * review — see lib/theme.tsx.
 */
import { useMemo, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { supabase } from '../lib/supabase';
import { newId } from '../lib/ids';
import { getInvokeErrorMessage } from '../lib/functionError';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'ImportTripit'>;
type Styles = ReturnType<typeof createStyles>;

type ExtractedFlight = {
  key: string;
  airline: string;
  flight_number: string;
  confirmation_code: string;
  departure_airport: string;
  departure_time: string;
  arrival_airport: string;
  arrival_time: string;
};

type ExtractedLodging = {
  key: string;
  hotel_name: string;
  address: string;
  check_in: string;
  check_out: string;
  confirmation_code: string;
};

export function ImportTripitScreen({ route, navigation }: Props) {
  const { tourId } = route.params;
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [phase, setPhase] = useState<'idle' | 'extracting' | 'review' | 'importing'>('idle');
  const [flights, setFlights] = useState<ExtractedFlight[]>([]);
  const [lodging, setLodging] = useState<ExtractedLodging[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleExtract() {
    setErrorMessage(null);
    setPhase('extracting');
    const { data, error } = await supabase.functions.invoke('extract-tripit', { body: { tourId } });
    if (error || data?.error) {
      setErrorMessage(await getInvokeErrorMessage(error, data, 'Import failed.'));
      setPhase('idle');
      return;
    }
    const rawFlights = (data?.flights ?? []) as Omit<ExtractedFlight, 'key'>[];
    const rawLodging = (data?.lodging ?? []) as Omit<ExtractedLodging, 'key'>[];
    if (rawFlights.length === 0 && rawLodging.length === 0) {
      setErrorMessage("Couldn't find any upcoming flights or lodging in your TripIt feed.");
      setPhase('idle');
      return;
    }
    setFlights(rawFlights.map((f) => ({ key: newId(), airline: f.airline ?? '', flight_number: f.flight_number ?? '', confirmation_code: f.confirmation_code ?? '', departure_airport: f.departure_airport ?? '', departure_time: f.departure_time ?? '', arrival_airport: f.arrival_airport ?? '', arrival_time: f.arrival_time ?? '' })));
    setLodging(rawLodging.map((l) => ({ key: newId(), hotel_name: l.hotel_name ?? '', address: l.address ?? '', check_in: l.check_in ?? '', check_out: l.check_out ?? '', confirmation_code: l.confirmation_code ?? '' })));
    setPhase('review');
  }

  function updateFlight(key: string, field: keyof ExtractedFlight, value: string) {
    setFlights((prev) => prev.map((f) => (f.key === key ? { ...f, [field]: value } : f)));
  }
  function removeFlight(key: string) {
    setFlights((prev) => prev.filter((f) => f.key !== key));
  }
  function updateLodgingRow(key: string, field: keyof ExtractedLodging, value: string) {
    setLodging((prev) => prev.map((l) => (l.key === key ? { ...l, [field]: value } : l)));
  }
  function removeLodging(key: string) {
    setLodging((prev) => prev.filter((l) => l.key !== key));
  }

  async function handleImport() {
    setErrorMessage(null);
    setPhase('importing');

    if (flights.length > 0) {
      const { error } = await supabase.from('flights').insert(
        flights.map((f) => ({
          tour_id: tourId,
          airline: f.airline.trim() || null,
          flight_number: f.flight_number.trim() || null,
          confirmation_code: f.confirmation_code.trim() || null,
          departure_airport: f.departure_airport.trim(),
          departure_time: f.departure_time.trim(),
          arrival_airport: f.arrival_airport.trim(),
          arrival_time: f.arrival_time.trim(),
        }))
      );
      if (error) {
        setPhase('review');
        setErrorMessage(error.message);
        return;
      }
    }

    if (lodging.length > 0) {
      const { error } = await supabase.from('lodging').insert(
        lodging.map((l) => ({
          tour_id: tourId,
          hotel_name: l.hotel_name.trim(),
          address: l.address.trim() || null,
          check_in: l.check_in.trim() || null,
          check_out: l.check_out.trim() || null,
          confirmation_code: l.confirmation_code.trim() || null,
        }))
      );
      if (error) {
        setPhase('review');
        setErrorMessage(error.message);
        return;
      }
    }

    navigation.goBack();
  }

  if (phase === 'idle') {
    return (
      <View style={styles.centeredContainer}>
        <Text style={styles.title}>Import from TripIt</Text>
        <Text style={styles.subtitle}>
          Pulls upcoming flights and lodging from your own TripIt feed (add the feed URL in Settings first) for
          you to review before anything's added.
        </Text>
        {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}
        <Pressable style={styles.pickButton} onPress={handleExtract}>
          <Text style={styles.pickButtonText}>Import from TripIt</Text>
        </Pressable>
      </View>
    );
  }

  if (phase === 'extracting') {
    return (
      <View style={styles.centeredContainer}>
        <ActivityIndicator color={colors.accent} size="large" />
        <Text style={styles.subtitle}>Reading your TripIt feed…</Text>
      </View>
    );
  }

  const total = flights.length + lodging.length;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Review before importing</Text>
      <Text style={styles.subtitle}>
        Found {flights.length} flight{flights.length === 1 ? '' : 's'} and {lodging.length} lodging booking
        {lodging.length === 1 ? '' : 's'}. Check everything below — nothing's saved yet.
      </Text>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      {flights.length > 0 && <Text style={styles.sectionTitle}>Flights</Text>}
      {flights.map((f, index) => (
        <View key={f.key} style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardIndex}>Flight {index + 1}</Text>
            <Pressable onPress={() => removeFlight(f.key)}>
              <Text style={styles.removeText}>Remove</Text>
            </Pressable>
          </View>
          <View style={styles.row}>
            <Field styles={styles} colors={colors} label="Airline" value={f.airline} onChange={(v) => updateFlight(f.key, 'airline', v)} flex />
            <Field styles={styles} colors={colors} label="Flight #" value={f.flight_number} onChange={(v) => updateFlight(f.key, 'flight_number', v)} flex />
          </View>
          <View style={styles.row}>
            <Field styles={styles} colors={colors} label="From" value={f.departure_airport} onChange={(v) => updateFlight(f.key, 'departure_airport', v)} flex />
            <Field styles={styles} colors={colors} label="To" value={f.arrival_airport} onChange={(v) => updateFlight(f.key, 'arrival_airport', v)} flex />
          </View>
          <View style={styles.row}>
            <Field styles={styles} colors={colors} label="Departs (ISO)" value={f.departure_time} onChange={(v) => updateFlight(f.key, 'departure_time', v)} flex />
            <Field styles={styles} colors={colors} label="Arrives (ISO)" value={f.arrival_time} onChange={(v) => updateFlight(f.key, 'arrival_time', v)} flex />
          </View>
          <Field styles={styles} colors={colors} label="Confirmation code" value={f.confirmation_code} onChange={(v) => updateFlight(f.key, 'confirmation_code', v)} />
        </View>
      ))}

      {lodging.length > 0 && <Text style={styles.sectionTitle}>Lodging</Text>}
      {lodging.map((l, index) => (
        <View key={l.key} style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardIndex}>Lodging {index + 1}</Text>
            <Pressable onPress={() => removeLodging(l.key)}>
              <Text style={styles.removeText}>Remove</Text>
            </Pressable>
          </View>
          <Field styles={styles} colors={colors} label="Hotel" value={l.hotel_name} onChange={(v) => updateLodgingRow(l.key, 'hotel_name', v)} />
          <Field styles={styles} colors={colors} label="Address" value={l.address} onChange={(v) => updateLodgingRow(l.key, 'address', v)} />
          <View style={styles.row}>
            <Field styles={styles} colors={colors} label="Check-in (YYYY-MM-DD)" value={l.check_in} onChange={(v) => updateLodgingRow(l.key, 'check_in', v)} flex />
            <Field styles={styles} colors={colors} label="Check-out (YYYY-MM-DD)" value={l.check_out} onChange={(v) => updateLodgingRow(l.key, 'check_out', v)} flex />
          </View>
          <Field styles={styles} colors={colors} label="Confirmation code" value={l.confirmation_code} onChange={(v) => updateLodgingRow(l.key, 'confirmation_code', v)} />
        </View>
      ))}

      <Pressable style={styles.importButton} onPress={handleImport} disabled={phase === 'importing' || total === 0}>
        {phase === 'importing' ? (
          <ActivityIndicator color={colors.onAccent} />
        ) : (
          <Text style={styles.importButtonText}>Import {total} Item{total === 1 ? '' : 's'}</Text>
        )}
      </Pressable>
    </ScrollView>
  );
}

function Field({
  label,
  value,
  onChange,
  flex,
  styles,
  colors,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  flex?: boolean;
  styles: Styles;
  colors: ThemeColors;
}) {
  return (
    <View style={flex ? styles.fieldFlex : styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput style={styles.fieldInput} value={value} onChangeText={onChange} placeholder="—" placeholderTextColor={colors.textFaint} />
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    centeredContainer: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
    content: { padding: 20, paddingBottom: 60 },
    title: { color: colors.text, fontSize: 22, fontFamily: fonts.displayBold, marginBottom: 8, textAlign: 'center' },
    subtitle: { color: colors.textDim, fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 16, fontFamily: fonts.body },
    sectionTitle: { color: colors.textDim, fontSize: 12, fontFamily: fonts.bodySemiBold, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 10, marginBottom: 8 },
    error: { color: colors.danger, fontSize: 13, textAlign: 'center', marginBottom: 12, fontFamily: fonts.body },
    pickButton: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 14, paddingHorizontal: 28, marginTop: 8 },
    pickButtonText: { color: colors.onAccent, fontSize: 16, fontFamily: fonts.bodySemiBold },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 12,
      padding: 14,
      marginBottom: 12,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.08,
      shadowRadius: 10,
      elevation: 2,
    },
    cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
    cardIndex: { color: colors.textDim, fontSize: 12, fontFamily: fonts.bodySemiBold, textTransform: 'uppercase', letterSpacing: 0.5 },
    removeText: { color: colors.danger, fontSize: 12, fontFamily: fonts.bodySemiBold },
    row: { flexDirection: 'row', gap: 10 },
    field: { marginBottom: 8 },
    fieldFlex: { flex: 1, marginBottom: 8 },
    fieldLabel: { color: colors.textFaint, fontSize: 11, marginBottom: 3, fontFamily: fonts.body },
    fieldInput: {
      backgroundColor: colors.bg,
      color: colors.text,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
      fontSize: 14,
      fontFamily: fonts.body,
      borderWidth: 1,
      borderColor: colors.border,
    },
    importButton: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
    importButtonText: { color: colors.onAccent, fontSize: 16, fontFamily: fonts.bodySemiBold },
  });
}
