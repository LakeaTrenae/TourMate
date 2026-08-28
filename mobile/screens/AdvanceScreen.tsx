/**
 * AdvanceScreen — one structured advance sheet per show date (power,
 * hospitality, schedule, parking, security, other). Loads-or-creates on
 * first visit (upsert on tour_date_id, which is unique) rather than
 * requiring a separate "start an advance" step. Chip styling copied from
 * AddChecklistScreen.tsx's department/visibility pattern.
 *
 * `advances` is a trigger-bearing table (completion-lock), so writes
 * follow the newId()-and-no-.select() convention from lib/ids.ts.
 */
import { useCallback, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { newId } from '../lib/ids';
import { formatDepartment } from '../lib/format';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Advance'>;

type Status = 'not_started' | 'in_progress' | 'confirmed';
const STATUSES: { value: Status; label: string }[] = [
  { value: 'not_started', label: 'Not started' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'confirmed', label: 'Confirmed' },
];
const DEPARTMENTS = ['tour_management', 'production', 'security', 'travel', 'artist_relations', 'finance', 'general'];
// Same base concept as AddChecklistScreen: visible_to_all only stores
// true/false, so 'specific' is a UI-level distinction, not a stored
// value — detected here by whether any resource_shares rows exist yet.
type Visibility = 'department' | 'org' | 'specific';

export function AdvanceScreen({ route, navigation }: Props) {
  const { tourId, tourDateId, tourDateLabel } = route.params;
  const { session } = useAuth();

  const [advanceId, setAdvanceId] = useState<string | null>(null);
  const [department, setDepartment] = useState('production');
  const [visibility, setVisibility] = useState<Visibility>('org');
  const [status, setStatus] = useState<Status>('not_started');
  const [powerNotes, setPowerNotes] = useState('');
  const [hospitalityNotes, setHospitalityNotes] = useState('');
  const [scheduleNotes, setScheduleNotes] = useState('');
  const [parkingNotes, setParkingNotes] = useState('');
  const [securityNotes, setSecurityNotes] = useState('');
  const [otherNotes, setOtherNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function load() {
    const { data, error } = await supabase
      .from('advances')
      .select('id, department, visible_to_all, status, power_notes, hospitality_notes, schedule_notes, parking_notes, security_notes, other_notes')
      .eq('tour_date_id', tourDateId)
      .maybeSingle();

    if (error) {
      setErrorMessage(error.message);
      return;
    }
    if (data) {
      setAdvanceId(data.id);
      setDepartment(data.department);
      setStatus(data.status);
      setPowerNotes(data.power_notes ?? '');
      setHospitalityNotes(data.hospitality_notes ?? '');
      setScheduleNotes(data.schedule_notes ?? '');
      setParkingNotes(data.parking_notes ?? '');
      setSecurityNotes(data.security_notes ?? '');
      setOtherNotes(data.other_notes ?? '');

      if (data.visible_to_all) {
        setVisibility('org');
      } else {
        const { count } = await supabase
          .from('resource_shares')
          .select('id', { count: 'exact', head: true })
          .eq('resource_type', 'advance')
          .eq('resource_id', data.id);
        setVisibility(count && count > 0 ? 'specific' : 'department');
      }
    }
  }

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load().finally(() => setLoading(false));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tourDateId])
  );

  async function handleSave() {
    if (!session) return;
    setErrorMessage(null);
    setSaving(true);

    const payload = {
      department,
      visible_to_all: visibility === 'org',
      status,
      power_notes: powerNotes.trim() || null,
      hospitality_notes: hospitalityNotes.trim() || null,
      schedule_notes: scheduleNotes.trim() || null,
      parking_notes: parkingNotes.trim() || null,
      security_notes: securityNotes.trim() || null,
      other_notes: otherNotes.trim() || null,
      updated_by: session.user.id,
      updated_at: new Date().toISOString(),
    };

    let error;
    if (advanceId) {
      ({ error } = await supabase.from('advances').update(payload).eq('id', advanceId));
    } else {
      const newAdvanceId = newId();
      ({ error } = await supabase.from('advances').insert({
        id: newAdvanceId,
        tour_date_id: tourDateId,
        created_by: session.user.id,
        ...payload,
      }));
      if (!error) setAdvanceId(newAdvanceId);
    }

    setSaving(false);
    if (error) setErrorMessage(error.message);
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
      <Text style={styles.title}>Advance</Text>
      <Text style={styles.subtitle}>{tourDateLabel}</Text>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <Text style={styles.sectionTitle}>Status</Text>
      <View style={styles.chipRow}>
        {STATUSES.map((s) => (
          <Pressable key={s.value} style={[styles.chip, status === s.value && styles.chipActive]} onPress={() => setStatus(s.value)}>
            <Text style={[styles.chipText, status === s.value && styles.chipTextActive]}>{s.label}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.sectionTitle}>Owning department</Text>
      <View style={styles.chipRow}>
        {DEPARTMENTS.map((d) => (
          <Pressable key={d} style={[styles.chip, department === d && styles.chipActive]} onPress={() => setDepartment(d)}>
            <Text style={[styles.chipText, department === d && styles.chipTextActive]}>{formatDepartment(d)}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.sectionTitle}>Who can see it</Text>
      <Pressable
        style={[styles.visibilityRow, visibility === 'department' && styles.visibilityRowSelected]}
        onPress={() => setVisibility('department')}
      >
        <Text style={styles.visibilityText}>Managers + this department</Text>
        {visibility === 'department' && <Text style={styles.check}>✓</Text>}
      </Pressable>
      <Pressable
        style={[styles.visibilityRow, visibility === 'org' && styles.visibilityRowSelected]}
        onPress={() => setVisibility('org')}
      >
        <Text style={styles.visibilityText}>Everyone on the tour</Text>
        {visibility === 'org' && <Text style={styles.check}>✓</Text>}
      </Pressable>
      <Pressable
        style={[styles.visibilityRow, visibility === 'specific' && styles.visibilityRowSelected]}
        onPress={() => setVisibility('specific')}
      >
        <Text style={styles.visibilityText}>Specific people or departments</Text>
        {visibility === 'specific' && <Text style={styles.check}>✓</Text>}
      </Pressable>
      {visibility === 'specific' &&
        (advanceId ? (
          <Pressable
            style={styles.shareLinkButton}
            onPress={() => navigation.navigate('AdvanceSharing', { advanceId, tourId, advanceLabel: `Advance — ${tourDateLabel}` })}
          >
            <Text style={styles.shareLinkButtonText}>Choose specific people or departments ›</Text>
          </Pressable>
        ) : (
          <Text style={styles.visibilityHint}>Save once first, then come back here to pick specific people or departments.</Text>
        ))}

      <Section label="Power" value={powerNotes} onChange={setPowerNotes} />
      <Section label="Hospitality" value={hospitalityNotes} onChange={setHospitalityNotes} />
      <Section label="Schedule" value={scheduleNotes} onChange={setScheduleNotes} />
      <Section label="Parking" value={parkingNotes} onChange={setParkingNotes} />
      <Section label="Security" value={securityNotes} onChange={setSecurityNotes} />
      <Section label="Other" value={otherNotes} onChange={setOtherNotes} />

      <Pressable style={styles.saveButton} onPress={handleSave} disabled={saving}>
        {saving ? <ActivityIndicator color="#0b0b0f" /> : <Text style={styles.saveButtonText}>Save Advance</Text>}
      </Pressable>
    </ScrollView>
  );
}

function Section({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{label}</Text>
      <TextInput
        style={styles.textArea}
        placeholder={`${label} details…`}
        placeholderTextColor="#6b6b76"
        value={value}
        onChangeText={onChange}
        multiline
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b0f' },
  centered: { flex: 1, backgroundColor: '#0b0b0f', alignItems: 'center', justifyContent: 'center' },
  content: { padding: 20, paddingBottom: 60 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700' },
  subtitle: { color: '#6b6b76', fontSize: 13, marginTop: 4, marginBottom: 16 },
  error: { color: '#ff6b6b', fontSize: 13, marginBottom: 12 },
  sectionTitle: { color: '#9a9aa5', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', marginTop: 14, marginBottom: 8 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { backgroundColor: '#1a1a20', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 },
  chipActive: { backgroundColor: '#fff' },
  chipText: { color: '#9a9aa5', fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: '#0b0b0f' },
  visibilityRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: '#1a1a20',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 6,
  },
  visibilityRowSelected: { backgroundColor: '#2a2a3a' },
  visibilityText: { color: '#fff', fontSize: 14 },
  check: { color: '#7c9cff', fontSize: 14, fontWeight: '700' },
  visibilityHint: { color: '#6b6b76', fontSize: 12, marginTop: -2, marginBottom: 8, fontStyle: 'italic' },
  shareLinkButton: { paddingVertical: 6, marginBottom: 8 },
  shareLinkButtonText: { color: '#7c9cff', fontSize: 13, fontWeight: '600' },
  section: { marginTop: 4 },
  textArea: {
    backgroundColor: '#1a1a20',
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    minHeight: 70,
    textAlignVertical: 'top',
  },
  saveButton: { backgroundColor: '#fff', borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 20 },
  saveButtonText: { color: '#0b0b0f', fontSize: 16, fontWeight: '600' },
});
