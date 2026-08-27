/**
 * ImportScheduleScreen — pick a routing sheet (PDF, photo, or spreadsheet),
 * send it to the extract-schedule edge function for AI extraction, then
 * let the manager review and edit every row before anything is written to
 * the database. The extraction is a starting point, not a commit — real
 * routing sheets are messy and the model will sometimes misread a field,
 * so nothing imports without a human looking at it first.
 *
 * The actual Claude call happens server-side (supabase/functions/
 * extract-schedule) — this screen never sees or needs an API key.
 *
 * Venue matching: each extracted venue_name/city gets resolved against
 * the tour's organization's existing venues (case-insensitive name match)
 * on import — a hit reuses that venue_id, a miss creates a new venue row
 * on the fly (name + city only; address/capacity/geocoding can be filled
 * in later from VenuesScreen). This replaced an earlier version that had
 * nowhere to put venue/city data and just concatenated it into the notes
 * field — now that tour_dates.venue_id (0001) has a real UI via
 * AddTourDateScreen/VenuesScreen, that workaround is gone.
 */
import { useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as DocumentPicker from 'expo-document-picker';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { supabase } from '../lib/supabase';
import { readFileAsBase64 } from '../lib/files';
import { newId } from '../lib/ids';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'ImportSchedule'>;

type ExtractedShow = {
  key: string; // local-only, for list rendering/editing — never sent to the DB
  date: string;
  venue_name: string;
  city: string;
  load_in: string;
  soundcheck: string;
  doors: string;
  set_time: string;
  notes: string;
};

type RawShow = {
  date: string;
  venue_name: string | null;
  city: string | null;
  load_in: string | null;
  soundcheck: string | null;
  doors: string | null;
  set_time: string | null;
  notes: string | null;
};

export function ImportScheduleScreen({ route, navigation }: Props) {
  const { tourId } = route.params;

  const [phase, setPhase] = useState<'idle' | 'extracting' | 'review' | 'importing'>('idle');
  const [fileName, setFileName] = useState<string | null>(null);
  const [shows, setShows] = useState<ExtractedShow[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handlePickAndExtract() {
    setErrorMessage(null);
    const result = await DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true });
    if (result.canceled || result.assets.length === 0) return;
    const asset = result.assets[0];

    setFileName(asset.name);
    setPhase('extracting');

    try {
      const base64Data = await readFileAsBase64(asset.uri);
      const { data, error } = await supabase.functions.invoke('extract-schedule', {
        body: {
          tourId,
          fileName: asset.name,
          mimeType: asset.mimeType ?? 'application/octet-stream',
          base64Data,
        },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      const raw: RawShow[] = data?.shows ?? [];
      if (raw.length === 0) {
        setErrorMessage("Couldn't find any show dates in that document. Try a clearer file, or add dates manually.");
        setPhase('idle');
        return;
      }

      setShows(
        raw.map((s) => ({
          key: newId(),
          date: s.date ?? '',
          venue_name: s.venue_name ?? '',
          city: s.city ?? '',
          load_in: s.load_in ?? '',
          soundcheck: s.soundcheck ?? '',
          doors: s.doors ?? '',
          set_time: s.set_time ?? '',
          notes: s.notes ?? '',
        }))
      );
      setPhase('review');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Extraction failed.');
      setPhase('idle');
    }
  }

  function updateShow(key: string, field: keyof ExtractedShow, value: string) {
    setShows((prev) => prev.map((s) => (s.key === key ? { ...s, [field]: value } : s)));
  }

  function removeShow(key: string) {
    setShows((prev) => prev.filter((s) => s.key !== key));
  }

  async function handleImport() {
    setErrorMessage(null);
    if (shows.length === 0) return;

    const invalidDate = shows.find((s) => Number.isNaN(new Date(s.date).getTime()));
    if (invalidDate) {
      setErrorMessage(`"${invalidDate.date}" isn't a valid date — fix it before importing.`);
      return;
    }

    setPhase('importing');

    const { data: tourRow, error: tourError } = await supabase.from('tours').select('organization_id').eq('id', tourId).single();
    if (tourError || !tourRow) {
      setPhase('review');
      setErrorMessage(tourError?.message ?? 'Could not resolve this tour.');
      return;
    }

    const organizationId = tourRow.organization_id;
    const { data: existingVenues, error: venuesError } = await supabase
      .from('venues')
      .select('id, name, city')
      .eq('organization_id', organizationId);
    if (venuesError) {
      setPhase('review');
      setErrorMessage(venuesError.message);
      return;
    }

    // Cache of "name|city" (lowercased) -> venue_id, seeded from existing
    // org venues and grown as new ones get created during this import —
    // so two shows at the same never-before-seen venue in one batch
    // reuse the same new row instead of creating a duplicate each.
    const venueCache = new Map<string, string>();
    for (const v of existingVenues ?? []) {
      venueCache.set(venueCacheKey(v.name, v.city ?? ''), v.id);
    }

    async function resolveVenueId(venueName: string, city: string): Promise<string | null> {
      const name = venueName.trim();
      if (!name) return null;
      const key = venueCacheKey(name, city.trim());
      const cached = venueCache.get(key);
      if (cached) return cached;

      const { data, error } = await supabase
        .from('venues')
        .insert({ organization_id: organizationId, name, city: city.trim() || null })
        .select('id')
        .single();
      if (error || !data) return null; // venue creation failing shouldn't block the whole import
      venueCache.set(key, data.id);
      return data.id;
    }

    const rows = [];
    for (const s of shows) {
      const venueId = await resolveVenueId(s.venue_name, s.city);
      rows.push({
        tour_id: tourId,
        venue_id: venueId,
        date: s.date.trim(),
        load_in: s.load_in.trim() || null,
        soundcheck: s.soundcheck.trim() || null,
        doors: s.doors.trim() || null,
        set_time: s.set_time.trim() || null,
        notes: s.notes.trim() || null,
      });
    }

    const { error } = await supabase.from('tour_dates').insert(rows);
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
        <Text style={styles.title}>Import Schedule</Text>
        <Text style={styles.subtitle}>
          Upload a routing sheet — a PDF, a spreadsheet, or even a photo of a printed schedule — and
          we'll pull out the show dates for you to review before anything's added.
        </Text>
        {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}
        <Pressable style={styles.pickButton} onPress={handlePickAndExtract}>
          <Text style={styles.pickButtonText}>Choose a file</Text>
        </Pressable>
      </View>
    );
  }

  if (phase === 'extracting') {
    return (
      <View style={styles.centeredContainer}>
        <ActivityIndicator color="#fff" size="large" />
        <Text style={styles.subtitle}>Reading {fileName}…</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Review before importing</Text>
      <Text style={styles.subtitle}>
        Found {shows.length} show{shows.length === 1 ? '' : 's'} in {fileName}. Check everything below —
        nothing's saved yet.
      </Text>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      {shows.map((show, index) => (
        <View key={show.key} style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardIndex}>Show {index + 1}</Text>
            <Pressable onPress={() => removeShow(show.key)}>
              <Text style={styles.removeText}>Remove</Text>
            </Pressable>
          </View>

          <Field label="Date (YYYY-MM-DD)" value={show.date} onChange={(v) => updateShow(show.key, 'date', v)} />
          <Field label="Venue" value={show.venue_name} onChange={(v) => updateShow(show.key, 'venue_name', v)} />
          <Field label="City" value={show.city} onChange={(v) => updateShow(show.key, 'city', v)} />
          <View style={styles.row}>
            <Field label="Load-in" value={show.load_in} onChange={(v) => updateShow(show.key, 'load_in', v)} flex />
            <Field label="Soundcheck" value={show.soundcheck} onChange={(v) => updateShow(show.key, 'soundcheck', v)} flex />
          </View>
          <View style={styles.row}>
            <Field label="Doors" value={show.doors} onChange={(v) => updateShow(show.key, 'doors', v)} flex />
            <Field label="Set time" value={show.set_time} onChange={(v) => updateShow(show.key, 'set_time', v)} flex />
          </View>
          <Field label="Notes" value={show.notes} onChange={(v) => updateShow(show.key, 'notes', v)} />
        </View>
      ))}

      <Pressable style={styles.importButton} onPress={handleImport} disabled={phase === 'importing' || shows.length === 0}>
        {phase === 'importing' ? (
          <ActivityIndicator color="#0b0b0f" />
        ) : (
          <Text style={styles.importButtonText}>Import {shows.length} Date{shows.length === 1 ? '' : 's'}</Text>
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  flex?: boolean;
}) {
  return (
    <View style={flex ? styles.fieldFlex : styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput style={styles.fieldInput} value={value} onChangeText={onChange} placeholder="—" placeholderTextColor="#6b6b76" />
    </View>
  );
}

function venueCacheKey(name: string, city: string): string {
  return `${name.trim().toLowerCase()}|${city.trim().toLowerCase()}`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b0f' },
  centeredContainer: { flex: 1, backgroundColor: '#0b0b0f', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  content: { padding: 20, paddingBottom: 60 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  subtitle: { color: '#9a9aa5', fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 16 },
  error: { color: '#ff6b6b', fontSize: 13, textAlign: 'center', marginBottom: 12 },
  pickButton: { backgroundColor: '#fff', borderRadius: 10, paddingVertical: 14, paddingHorizontal: 28, marginTop: 8 },
  pickButtonText: { color: '#0b0b0f', fontSize: 16, fontWeight: '600' },
  card: { backgroundColor: '#1a1a20', borderRadius: 12, padding: 14, marginBottom: 12 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  cardIndex: { color: '#9a9aa5', fontSize: 12, fontWeight: '600', textTransform: 'uppercase' },
  removeText: { color: '#ff6b6b', fontSize: 12, fontWeight: '600' },
  row: { flexDirection: 'row', gap: 10 },
  field: { marginBottom: 8 },
  fieldFlex: { flex: 1, marginBottom: 8 },
  fieldLabel: { color: '#6b6b76', fontSize: 11, marginBottom: 3 },
  fieldInput: {
    backgroundColor: '#0b0b0f',
    color: '#fff',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
  },
  importButton: { backgroundColor: '#fff', borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
  importButtonText: { color: '#0b0b0f', fontSize: 16, fontWeight: '600' },
});