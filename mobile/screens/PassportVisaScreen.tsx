/**
 * PassportVisaScreen — self-view/edit by default; a manager can open it
 * read-only for a teammate via `targetUserId` (from DirectoryScreen).
 * RLS (`passport_visa readable by self or managers of a shared tour`,
 * `passport_visa updatable by self`, 0024) is the real enforcement — the
 * hidden Save button in viewer mode is a UI hint on top of that, not the
 * actual guard.
 *
 * `passport_visa_info` has no trigger, so this is one of the few writes
 * in the app that can safely chain `.select()` onto an upsert without
 * hitting the RETURNING/RLS interaction documented in lib/ids.ts.
 *
 * Theme (Manrope/JetBrains Mono, navy accent) per the "Load-In" design
 * review — see lib/theme.tsx.
 */
import { useCallback, useMemo, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, Pressable, View } from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'PassportVisa'>;

export function PassportVisaScreen({ route }: Props) {
  const { targetUserId, targetName } = route.params;
  const { session } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const viewingSelf = !targetUserId || targetUserId === session?.user.id;
  const subjectId = targetUserId ?? session?.user.id ?? '';

  const [passportNumber, setPassportNumber] = useState('');
  const [passportCountry, setPassportCountry] = useState('');
  const [passportExpiry, setPassportExpiry] = useState('');
  const [visaType, setVisaType] = useState('');
  const [visaNumber, setVisaNumber] = useState('');
  const [visaExpiry, setVisaExpiry] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  async function load() {
    if (!subjectId) return;
    const { data, error } = await supabase
      .from('passport_visa_info')
      .select('passport_number, passport_country, passport_expiry, visa_type, visa_number, visa_expiry, notes')
      .eq('user_id', subjectId)
      .maybeSingle();

    if (error) {
      // A manager without a shared managed tour gets zero rows back from
      // RLS, not an error — this branch is a genuine query failure.
      setErrorMessage(error.message);
      return;
    }
    if (!data) {
      setNotFound(true);
      return;
    }
    setPassportNumber(data.passport_number ?? '');
    setPassportCountry(data.passport_country ?? '');
    setPassportExpiry(data.passport_expiry ?? '');
    setVisaType(data.visa_type ?? '');
    setVisaNumber(data.visa_number ?? '');
    setVisaExpiry(data.visa_expiry ?? '');
    setNotes(data.notes ?? '');
  }

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load().finally(() => setLoading(false));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [subjectId])
  );

  async function handleSave() {
    setErrorMessage(null);
    setSaving(true);
    const { error } = await supabase.from('passport_visa_info').upsert(
      {
        user_id: subjectId,
        passport_number: passportNumber.trim() || null,
        passport_country: passportCountry.trim() || null,
        passport_expiry: passportExpiry.trim() || null,
        visa_type: visaType.trim() || null,
        visa_number: visaNumber.trim() || null,
        visa_expiry: visaExpiry.trim() || null,
        notes: notes.trim() || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );
    setSaving(false);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    setNotFound(false);
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
      <Text style={styles.title}>Passport & Visa</Text>
      <Text style={styles.subtitle}>{viewingSelf ? 'Only you can edit this.' : `Viewing ${targetName ?? 'this person'} — read only.`}</Text>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}
      {notFound && !viewingSelf && <Text style={styles.emptyText}>Nothing on file yet.</Text>}

      <Text style={styles.sectionTitle}>Passport</Text>
      <TextInput
        style={styles.input}
        placeholder="Passport number"
        placeholderTextColor={colors.textFaint}
        value={passportNumber}
        onChangeText={setPassportNumber}
        editable={viewingSelf}
      />
      <View style={styles.row}>
        <TextInput style={[styles.input, styles.rowInput]} placeholder="Issuing country" placeholderTextColor={colors.textFaint} value={passportCountry} onChangeText={setPassportCountry} editable={viewingSelf} />
        <TextInput style={[styles.input, styles.rowInput]} placeholder="Expiry (YYYY-MM-DD)" placeholderTextColor={colors.textFaint} value={passportExpiry} onChangeText={setPassportExpiry} editable={viewingSelf} />
      </View>

      <Text style={styles.sectionTitle}>Visa</Text>
      <TextInput style={styles.input} placeholder="Visa type (e.g. P-2, ESTA)" placeholderTextColor={colors.textFaint} value={visaType} onChangeText={setVisaType} editable={viewingSelf} />
      <View style={styles.row}>
        <TextInput style={[styles.input, styles.rowInput]} placeholder="Visa number" placeholderTextColor={colors.textFaint} value={visaNumber} onChangeText={setVisaNumber} editable={viewingSelf} />
        <TextInput style={[styles.input, styles.rowInput]} placeholder="Expiry (YYYY-MM-DD)" placeholderTextColor={colors.textFaint} value={visaExpiry} onChangeText={setVisaExpiry} editable={viewingSelf} />
      </View>

      <Text style={styles.sectionTitle}>Notes</Text>
      <TextInput
        style={[styles.input, styles.notesInput]}
        placeholder="Anything else worth flagging"
        placeholderTextColor={colors.textFaint}
        value={notes}
        onChangeText={setNotes}
        editable={viewingSelf}
        multiline
      />

      {viewingSelf && (
        <Pressable style={styles.saveButton} onPress={handleSave} disabled={saving}>
          {saving ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.saveButtonText}>Save</Text>}
        </Pressable>
      )}
    </ScrollView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    centered: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
    content: { padding: 20, paddingBottom: 60 },
    title: { color: colors.text, fontSize: 22, fontFamily: fonts.displayBold },
    subtitle: { color: colors.textDim, fontSize: 13, marginTop: 4, marginBottom: 16, fontFamily: fonts.body },
    error: { color: colors.danger, fontSize: 13, marginBottom: 12, fontFamily: fonts.body },
    emptyText: { color: colors.textFaint, fontSize: 13, marginBottom: 12, fontFamily: fonts.body },
    sectionTitle: { color: colors.textDim, fontSize: 12, fontFamily: fonts.bodySemiBold, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 16, marginBottom: 8 },
    input: {
      backgroundColor: colors.surface,
      color: colors.text,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      marginBottom: 10,
      fontSize: 15,
      fontFamily: fonts.body,
      borderWidth: 1,
      borderColor: colors.border,
    },
    row: { flexDirection: 'row', gap: 10 },
    rowInput: { flex: 1 },
    notesInput: { minHeight: 80, textAlignVertical: 'top' },
    saveButton: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 12 },
    saveButtonText: { color: colors.onAccent, fontSize: 16, fontFamily: fonts.bodySemiBold },
  });
}
