/**
 * ImportGuestListScreen — pick a guest list document (PDF, photo, or
 * spreadsheet), send it to the extract-guestlist edge function for AI
 * extraction, then let the reviewer confirm every row — including which
 * show date it belongs to, since guest_list_requests.tour_date_id is
 * required — before anything is written. Same idle → extracting → review
 * → importing phase machine as ImportScheduleScreen/ImportBudgetScreen.
 *
 * Imported guests are inserted as already-approved (status: 'approved'),
 * not the default 'pending' a crew member's own ad-hoc request gets —
 * these represent an already-confirmed external list a manager or artist
 * is bringing in, not a new request awaiting review.
 *
 * Theme (Manrope/JetBrains Mono, navy accent) per the "Load-In" design
 * review — see lib/theme.tsx.
 */
import { useEffect, useMemo, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as DocumentPicker from 'expo-document-picker';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { readFileAsBase64 } from '../lib/files';
import { newId } from '../lib/ids';
import { formatDateOnly } from '../lib/dates';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'ImportGuestList'>;
type Styles = ReturnType<typeof createStyles>;

type TourDateOption = { id: string; date: string };
type ExtractedGuest = { key: string; tourDateId: string | null; guestName: string; guestCount: string; notes: string };
type RawGuest = { date_label: string | null; guest_name: string; guest_count: number; notes: string | null };

export function ImportGuestListScreen({ route, navigation }: Props) {
  const { tourId } = route.params;
  const { session } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [phase, setPhase] = useState<'idle' | 'extracting' | 'review' | 'importing'>('idle');
  const [fileName, setFileName] = useState<string | null>(null);
  const [tourDates, setTourDates] = useState<TourDateOption[]>([]);
  const [guests, setGuests] = useState<ExtractedGuest[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from('tour_dates')
      .select('id, date')
      .eq('tour_id', tourId)
      .order('date', { ascending: true })
      .then(({ data }) => setTourDates(data ?? []));
  }, [tourId]);

  async function handlePickAndExtract() {
    setErrorMessage(null);
    const result = await DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true });
    if (result.canceled || result.assets.length === 0) return;
    const asset = result.assets[0];

    setFileName(asset.name);
    setPhase('extracting');

    try {
      const base64Data = await readFileAsBase64(asset.uri);
      const { data, error } = await supabase.functions.invoke('extract-guestlist', {
        body: { tourId, fileName: asset.name, mimeType: asset.mimeType ?? 'application/octet-stream', base64Data },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      const raw: RawGuest[] = data?.guests ?? [];
      if (raw.length === 0) {
        setErrorMessage("Couldn't find any guests in that document. Try a clearer file, or add requests manually.");
        setPhase('idle');
        return;
      }

      const dateByLabel = new Map(tourDates.map((d) => [d.date, d.id]));
      setGuests(
        raw.map((g) => ({
          key: newId(),
          tourDateId: (g.date_label && dateByLabel.get(g.date_label)) ?? tourDates[0]?.id ?? null,
          guestName: g.guest_name ?? '',
          guestCount: String(g.guest_count ?? 1),
          notes: g.notes ?? '',
        }))
      );
      setPhase('review');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Extraction failed.');
      setPhase('idle');
    }
  }

  function updateGuest(key: string, field: 'guestName' | 'guestCount' | 'notes', value: string) {
    setGuests((prev) => prev.map((g) => (g.key === key ? { ...g, [field]: value } : g)));
  }
  function setGuestDate(key: string, tourDateId: string) {
    setGuests((prev) => prev.map((g) => (g.key === key ? { ...g, tourDateId } : g)));
  }
  function removeGuest(key: string) {
    setGuests((prev) => prev.filter((g) => g.key !== key));
  }

  async function handleImport() {
    setErrorMessage(null);
    if (guests.length === 0 || !session) return;

    const missingDate = guests.find((g) => !g.tourDateId);
    if (missingDate) {
      setErrorMessage(`"${missingDate.guestName}" needs a show date — add one first if this tour has no dates yet.`);
      return;
    }

    setPhase('importing');
    const { error } = await supabase.from('guest_list_requests').insert(
      guests.map((g) => ({
        tour_date_id: g.tourDateId,
        requested_by: session.user.id,
        guest_name: g.guestName.trim() || 'Guest',
        guest_count: parseInt(g.guestCount, 10) || 1,
        status: 'approved' as const,
        notes: g.notes.trim() || null,
      }))
    );
    setPhase('review');

    if (error) {
      setErrorMessage(error.message);
      return;
    }
    navigation.goBack();
  }

  if (phase === 'idle') {
    return (
      <View style={styles.centeredContainer}>
        <Text style={styles.title}>Import Guest List</Text>
        <Text style={styles.subtitle}>
          Upload a guest list — a spreadsheet, a PDF, or even a photo of a printed list — and we'll pull out every
          guest for you to review before anything's added.
        </Text>
        {tourDates.length === 0 && <Text style={styles.error}>Add at least one show date to this tour before importing a guest list.</Text>}
        {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}
        <Pressable style={styles.pickButton} onPress={handlePickAndExtract} disabled={tourDates.length === 0}>
          <Text style={styles.pickButtonText}>Choose a file</Text>
        </Pressable>
      </View>
    );
  }

  if (phase === 'extracting') {
    return (
      <View style={styles.centeredContainer}>
        <ActivityIndicator color={colors.accent} size="large" />
        <Text style={styles.subtitle}>Reading {fileName}…</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Review before importing</Text>
      <Text style={styles.subtitle}>
        Found {guests.length} guest{guests.length === 1 ? '' : 's'} in {fileName}. Check everything below — nothing's
        saved yet.
      </Text>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      {guests.map((guest, index) => (
        <View key={guest.key} style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardIndex}>Guest {index + 1}</Text>
            <Pressable onPress={() => removeGuest(guest.key)}>
              <Text style={styles.removeText}>Remove</Text>
            </Pressable>
          </View>

          <Field styles={styles} colors={colors} label="Name" value={guest.guestName} onChange={(v) => updateGuest(guest.key, 'guestName', v)} />
          <View style={styles.row}>
            <Field styles={styles} colors={colors} label="Count" value={guest.guestCount} onChange={(v) => updateGuest(guest.key, 'guestCount', v)} flex />
          </View>
          <Field styles={styles} colors={colors} label="Notes" value={guest.notes} onChange={(v) => updateGuest(guest.key, 'notes', v)} />

          <Text style={styles.fieldLabel}>Show date</Text>
          <View style={styles.chipRow}>
            {tourDates.map((d) => (
              <Pressable key={d.id} style={[styles.chip, guest.tourDateId === d.id && styles.chipActive]} onPress={() => setGuestDate(guest.key, d.id)}>
                <Text style={[styles.chipText, guest.tourDateId === d.id && styles.chipTextActive]}>{formatDateOnly(d.date, { month: 'short', day: 'numeric' })}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ))}

      <Pressable style={styles.importButton} onPress={handleImport} disabled={phase === 'importing' || guests.length === 0}>
        {phase === 'importing' ? (
          <ActivityIndicator color={colors.onAccent} />
        ) : (
          <Text style={styles.importButtonText}>Import {guests.length} Guest{guests.length === 1 ? '' : 's'}</Text>
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
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 },
    chip: { backgroundColor: colors.surface2, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6 },
    chipActive: { backgroundColor: colors.accent },
    chipText: { color: colors.textDim, fontSize: 12, fontFamily: fonts.bodySemiBold },
    chipTextActive: { color: colors.onAccent },
    importButton: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
    importButtonText: { color: colors.onAccent, fontSize: 16, fontFamily: fonts.bodySemiBold },
  });
}
