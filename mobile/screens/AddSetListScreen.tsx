/**
 * AddSetListScreen — create a new set list: name, which act it's for
 * (optional), whether it's a standing set or a one-night override for a
 * specific show, who owns editing, and who can see it. Songs get added
 * afterward on SetListDetailScreen, same split AddChecklistScreen uses.
 *
 * Theme (Manrope/JetBrains Mono, navy accent) per the "Load-In" design
 * review — see lib/theme.tsx.
 */
import { useEffect, useMemo, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { newId } from '../lib/ids';
import { formatDepartment } from '../lib/format';
import { formatDateOnly } from '../lib/dates';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'AddSetList'>;

const DEPARTMENTS = ['artist_relations', 'production', 'general', 'security', 'travel', 'finance', 'tour_management'];
type Visibility = 'department' | 'org' | 'specific';

type Artist = { id: string; name: string };
type TourDateOption = { id: string; date: string };

export function AddSetListScreen({ route, navigation }: Props) {
  const { tourId } = route.params;
  const { session } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [name, setName] = useState('Set List');
  const [department, setDepartment] = useState('artist_relations');
  const [visibility, setVisibility] = useState<Visibility>('org');
  const [artists, setArtists] = useState<Artist[]>([]);
  const [artistId, setArtistId] = useState<string | null>(null);
  const [tourDates, setTourDates] = useState<TourDateOption[]>([]);
  const [tourDateId, setTourDateId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from('artists')
      .select('id, name')
      .eq('tour_id', tourId)
      .order('name', { ascending: true })
      .then(({ data }) => setArtists(data ?? []));
    supabase
      .from('tour_dates')
      .select('id, date')
      .eq('tour_id', tourId)
      .order('date', { ascending: true })
      .then(({ data }) => setTourDates(data ?? []));
  }, [tourId]);

  async function handleSubmit() {
    setErrorMessage(null);
    if (!name.trim()) {
      setErrorMessage('Give this set list a name.');
      return;
    }
    if (!session) return;

    setSubmitting(true);
    const { error } = await supabase.from('setlists').insert({
      id: newId(),
      tour_id: tourId,
      artist_id: artistId,
      tour_date_id: tourDateId,
      name: name.trim(),
      department,
      visible_to_all: visibility === 'org',
      created_by: session.user.id,
    });
    setSubmitting(false);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    navigation.goBack();
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>New Set List</Text>

      <TextInput style={styles.input} placeholder="Set list name" placeholderTextColor={colors.textFaint} value={name} onChangeText={setName} />

      {artists.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>Which act (optional)</Text>
          <View style={styles.chipRow}>
            <Pressable style={[styles.chip, artistId === null && styles.chipActive]} onPress={() => setArtistId(null)}>
              <Text style={[styles.chipText, artistId === null && styles.chipTextActive]}>Whole tour</Text>
            </Pressable>
            {artists.map((a) => (
              <Pressable key={a.id} style={[styles.chip, artistId === a.id && styles.chipActive]} onPress={() => setArtistId(a.id)}>
                <Text style={[styles.chipText, artistId === a.id && styles.chipTextActive]}>{a.name}</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}

      {tourDates.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>Standing set, or one specific show?</Text>
          <View style={styles.chipRow}>
            <Pressable style={[styles.chip, tourDateId === null && styles.chipActive]} onPress={() => setTourDateId(null)}>
              <Text style={[styles.chipText, tourDateId === null && styles.chipTextActive]}>Standing set</Text>
            </Pressable>
            {tourDates.map((d) => (
              <Pressable key={d.id} style={[styles.chip, tourDateId === d.id && styles.chipActive]} onPress={() => setTourDateId(d.id)}>
                <Text style={[styles.chipText, tourDateId === d.id && styles.chipTextActive]}>
                  {formatDateOnly(d.date, { month: 'short', day: 'numeric' })}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      )}

      <Text style={styles.sectionTitle}>Department (owns editing)</Text>
      <View style={styles.chipRow}>
        {DEPARTMENTS.map((d) => (
          <Pressable key={d} style={[styles.chip, department === d && styles.chipActive]} onPress={() => setDepartment(d)}>
            <Text style={[styles.chipText, department === d && styles.chipTextActive]}>{formatDepartment(d)}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.sectionTitle}>Who can see it</Text>
      <Pressable style={[styles.visibilityRow, visibility === 'department' && styles.visibilityRowSelected]} onPress={() => setVisibility('department')}>
        <Text style={styles.visibilityText}>Managers + this department</Text>
        {visibility === 'department' && <Text style={styles.check}>✓</Text>}
      </Pressable>
      <Pressable style={[styles.visibilityRow, visibility === 'org' && styles.visibilityRowSelected]} onPress={() => setVisibility('org')}>
        <Text style={styles.visibilityText}>Everyone on the tour</Text>
        {visibility === 'org' && <Text style={styles.check}>✓</Text>}
      </Pressable>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <Pressable style={styles.submitButton} onPress={handleSubmit} disabled={submitting}>
        {submitting ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.submitButtonText}>Create Set List</Text>}
      </Pressable>
    </ScrollView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    content: { padding: 20, paddingBottom: 60 },
    title: { color: colors.text, fontSize: 22, fontFamily: fonts.displayBold, marginBottom: 16 },
    sectionTitle: { color: colors.textDim, fontSize: 12, fontFamily: fonts.bodySemiBold, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 14, marginBottom: 8 },
    input: {
      backgroundColor: colors.surface,
      color: colors.text,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 15,
      fontFamily: fonts.body,
      borderWidth: 1,
      borderColor: colors.border,
    },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: { backgroundColor: colors.surface2, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 },
    chipActive: { backgroundColor: colors.accent },
    chipText: { color: colors.textDim, fontSize: 13, fontFamily: fonts.bodySemiBold },
    chipTextActive: { color: colors.onAccent },
    visibilityRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      backgroundColor: colors.surface,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 10,
      marginBottom: 6,
      borderWidth: 1,
      borderColor: colors.border,
    },
    visibilityRowSelected: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
    visibilityText: { color: colors.text, fontSize: 14, fontFamily: fonts.body },
    check: { color: colors.accent, fontSize: 14, fontFamily: fonts.bodyBold },
    error: { color: colors.danger, fontSize: 13, marginTop: 12, fontFamily: fonts.body },
    submitButton: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 20 },
    submitButtonText: { color: colors.onAccent, fontSize: 16, fontFamily: fonts.bodySemiBold },
  });
}
