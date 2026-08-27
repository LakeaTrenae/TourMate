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
 */
import { useCallback, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, Pressable, View } from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'PassportVisa'>;

export function PassportVisaScreen({ route }: Props) {
  const { targetUserId, targetName } = route.params;
  const { session } = useAuth();

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
        <ActivityIndicator color="#fff" />
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
        placeholderTextColor="#6b6b76"
        value={passportNumber}
        onChangeText={setPassportNumber}
        editable={viewingSelf}
      />
      <View style={styles.row}>
        <TextInput style={[styles.input, styles.rowInput]} placeholder="Issuing country" placeholderTextColor="#6b6b76" value={passportCountry} onChangeText={setPassportCountry} editable={viewingSelf} />
        <TextInput style={[styles.input, styles.rowInput]} placeholder="Expiry (YYYY-MM-DD)" placeholderTextColor="#6b6b76" value={passportExpiry} onChangeText={setPassportExpiry} editable={viewingSelf} />
      </View>

      <Text style={styles.sectionTitle}>Visa</Text>
      <TextInput style={styles.input} placeholder="Visa type (e.g. P-2, ESTA)" placeholderTextColor="#6b6b76" value={visaType} onChangeText={setVisaType} editable={viewingSelf} />
      <View style={styles.row}>
        <TextInput style={[styles.input, styles.rowInput]} placeholder="Visa number" placeholderTextColor="#6b6b76" value={visaNumber} onChangeText={setVisaNumber} editable={viewingSelf} />
        <TextInput style={[styles.input, styles.rowInput]} placeholder="Expiry (YYYY-MM-DD)" placeholderTextColor="#6b6b76" value={visaExpiry} onChangeText={setVisaExpiry} editable={viewingSelf} />
      </View>

      <Text style={styles.sectionTitle}>Notes</Text>
      <TextInput
        style={[styles.input, styles.notesInput]}
        placeholder="Anything else worth flagging"
        placeholderTextColor="#6b6b76"
        value={notes}
        onChangeText={setNotes}
        editable={viewingSelf}
        multiline
      />

      {viewingSelf && (
        <Pressable style={styles.saveButton} onPress={handleSave} disabled={saving}>
          {saving ? <ActivityIndicator color="#0b0b0f" /> : <Text style={styles.saveButtonText}>Save</Text>}
        </Pressable>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b0f' },
  centered: { flex: 1, backgroundColor: '#0b0b0f', alignItems: 'center', justifyContent: 'center' },
  content: { padding: 20, paddingBottom: 60 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700' },
  subtitle: { color: '#6b6b76', fontSize: 13, marginTop: 4, marginBottom: 16 },
  error: { color: '#ff6b6b', fontSize: 13, marginBottom: 12 },
  emptyText: { color: '#6b6b76', fontSize: 13, marginBottom: 12 },
  sectionTitle: { color: '#9a9aa5', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', marginTop: 16, marginBottom: 8 },
  input: {
    backgroundColor: '#1a1a20',
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 10,
    fontSize: 15,
  },
  row: { flexDirection: 'row', gap: 10 },
  rowInput: { flex: 1 },
  notesInput: { minHeight: 80, textAlignVertical: 'top' },
  saveButton: { backgroundColor: '#fff', borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 12 },
  saveButtonText: { color: '#0b0b0f', fontSize: 16, fontWeight: '600' },
});
