/**
 * AddGuestRequestScreen — submit a guest list request for a specific show
 * date. Reachable by anyone on the tour (not manager-gated) — matches
 * "guest_list insertable by members" in 0001_init.sql.
 */
import { useEffect, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
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
import { useAuth } from '../lib/auth-context';
import { formatDateOnly } from '../lib/dates';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'AddGuestRequest'>;

type TourDate = { id: string; date: string };

export function AddGuestRequestScreen({ route, navigation }: Props) {
  const { tourId } = route.params;
  const { session } = useAuth();

  const [dates, setDates] = useState<TourDate[]>([]);
  const [selectedDateId, setSelectedDateId] = useState<string | null>(null);
  const [guestName, setGuestName] = useState('');
  const [guestCount, setGuestCount] = useState('1');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from('tour_dates')
      .select('id, date')
      .eq('tour_id', tourId)
      .order('date', { ascending: true })
      .then(({ data, error }) => {
        if (error) {
          setErrorMessage(error.message);
          return;
        }
        setDates(data ?? []);
        if (data && data.length > 0) setSelectedDateId(data[0].id);
      });
  }, [tourId]);

  async function handleSubmit() {
    setErrorMessage(null);

    if (!session) return;
    if (!selectedDateId) {
      setErrorMessage('Pick a show date.');
      return;
    }
    if (!guestName.trim()) {
      setErrorMessage('Enter a guest name.');
      return;
    }
    const count = parseInt(guestCount, 10);
    if (Number.isNaN(count) || count < 1) {
      setErrorMessage('Guest count must be at least 1.');
      return;
    }

    setSubmitting(true);
    const { error } = await supabase.from('guest_list_requests').insert({
      tour_date_id: selectedDateId,
      requested_by: session.user.id,
      guest_name: guestName.trim(),
      guest_count: count,
      notes: notes.trim() || null,
    });
    setSubmitting(false);

    if (error) {
      setErrorMessage(error.message);
      return;
    }
    navigation.goBack();
  }

  function formatDate(dateStr: string) {
    return formatDateOnly(dateStr, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Add Guest Request</Text>

      <Text style={styles.sectionTitle}>Show date</Text>
      {dates.map((d) => (
        <Pressable
          key={d.id}
          style={[styles.dateRow, selectedDateId === d.id && styles.dateRowSelected]}
          onPress={() => setSelectedDateId(d.id)}
        >
          <Text style={styles.dateRowText}>{formatDate(d.date)}</Text>
          {selectedDateId === d.id && <Text style={styles.check}>✓</Text>}
        </Pressable>
      ))}

      <TextInput style={styles.input} placeholder="Guest name" placeholderTextColor="#6b6b76" value={guestName} onChangeText={setGuestName} />
      <TextInput
        style={styles.input}
        placeholder="Number of guests"
        placeholderTextColor="#6b6b76"
        value={guestCount}
        onChangeText={setGuestCount}
        keyboardType="number-pad"
      />
      <TextInput style={styles.input} placeholder="Notes (optional)" placeholderTextColor="#6b6b76" value={notes} onChangeText={setNotes} multiline />

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <Pressable style={styles.submitButton} onPress={handleSubmit} disabled={submitting}>
        {submitting ? <ActivityIndicator color="#0b0b0f" /> : <Text style={styles.submitButtonText}>Submit Request</Text>}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b0f' },
  content: { padding: 20, paddingBottom: 60 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700', marginBottom: 16 },
  sectionTitle: { color: '#fff', fontSize: 14, fontWeight: '600', marginBottom: 8 },
  dateRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: '#1a1a20',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 6,
  },
  dateRowSelected: { backgroundColor: '#2a2a3a' },
  dateRowText: { color: '#fff', fontSize: 14 },
  check: { color: '#7c9cff', fontSize: 14, fontWeight: '700' },
  input: {
    backgroundColor: '#1a1a20',
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 12,
    fontSize: 15,
  },
  error: { color: '#ff6b6b', fontSize: 13, marginTop: 8 },
  submitButton: {
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 16,
  },
  submitButtonText: { color: '#0b0b0f', fontSize: 16, fontWeight: '600' },
});