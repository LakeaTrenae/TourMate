/**
 * EmergencyContactScreen — near-verbatim structural copy of
 * PassportVisaScreen: self-view/edit by default, a manager can open it
 * read-only for a teammate via `targetUserId` (from DirectoryScreen).
 * RLS (`emergency_contact readable by self or managers of a shared tour`,
 * `emergency_contact updatable by self`, 0032) is the real enforcement —
 * the hidden Save button in viewer mode is a UI hint on top of that, not
 * the actual guard.
 *
 * `emergency_contact_info` has no trigger, so this write can safely
 * chain nothing extra — a plain upsert, same as passport_visa_info.
 */
import { useCallback, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, Pressable, View } from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'EmergencyContact'>;

export function EmergencyContactScreen({ route }: Props) {
  const { targetUserId, targetName } = route.params;
  const { session } = useAuth();

  const viewingSelf = !targetUserId || targetUserId === session?.user.id;
  const subjectId = targetUserId ?? session?.user.id ?? '';

  const [contactName, setContactName] = useState('');
  const [relationship, setRelationship] = useState('');
  const [phone, setPhone] = useState('');
  const [alternatePhone, setAlternatePhone] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  async function load() {
    if (!subjectId) return;
    const { data, error } = await supabase
      .from('emergency_contact_info')
      .select('contact_name, relationship, phone, alternate_phone, notes')
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
    setContactName(data.contact_name ?? '');
    setRelationship(data.relationship ?? '');
    setPhone(data.phone ?? '');
    setAlternatePhone(data.alternate_phone ?? '');
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
    const { error } = await supabase.from('emergency_contact_info').upsert(
      {
        user_id: subjectId,
        contact_name: contactName.trim() || null,
        relationship: relationship.trim() || null,
        phone: phone.trim() || null,
        alternate_phone: alternatePhone.trim() || null,
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
      <Text style={styles.title}>Emergency Contact</Text>
      <Text style={styles.subtitle}>{viewingSelf ? 'Only you can edit this.' : `Viewing ${targetName ?? 'this person'} — read only.`}</Text>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}
      {notFound && !viewingSelf && <Text style={styles.emptyText}>Nothing on file yet.</Text>}

      <Text style={styles.sectionTitle}>Contact</Text>
      <TextInput
        style={styles.input}
        placeholder="Contact name"
        placeholderTextColor="#6b6b76"
        value={contactName}
        onChangeText={setContactName}
        editable={viewingSelf}
      />
      <TextInput
        style={styles.input}
        placeholder="Relationship (e.g. Spouse, Parent)"
        placeholderTextColor="#6b6b76"
        value={relationship}
        onChangeText={setRelationship}
        editable={viewingSelf}
      />
      <View style={styles.row}>
        <TextInput style={[styles.input, styles.rowInput]} placeholder="Phone" placeholderTextColor="#6b6b76" value={phone} onChangeText={setPhone} editable={viewingSelf} keyboardType="phone-pad" />
        <TextInput style={[styles.input, styles.rowInput]} placeholder="Alternate phone" placeholderTextColor="#6b6b76" value={alternatePhone} onChangeText={setAlternatePhone} editable={viewingSelf} keyboardType="phone-pad" />
      </View>

      <Text style={styles.sectionTitle}>Notes</Text>
      <TextInput
        style={[styles.input, styles.notesInput]}
        placeholder="Allergies, medical conditions, anything responders should know"
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
