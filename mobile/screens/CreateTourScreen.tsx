/**
 * CreateTourScreen — deliberately just asks for a name. No start/end
 * date fields: those are derived automatically from the tour's schedule
 * once show dates exist (see 0016_auto_compute_tour_dates.sql) — nothing
 * to type in, nothing that can drift out of sync with the real schedule.
 */
import { useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { newId } from '../lib/ids';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'CreateTour'>;

export function CreateTourScreen({ route, navigation }: Props) {
  const { organizationId } = route.params;
  const { session } = useAuth();
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit() {
    setErrorMessage(null);
    if (!session) return;
    if (!name.trim()) {
      setErrorMessage('Enter a tour name.');
      return;
    }

    setSubmitting(true);
    const tourId = newId();
    const { error } = await supabase.from('tours').insert({
      id: tourId,
      organization_id: organizationId,
      name: name.trim(),
      created_by: session.user.id,
    });
    setSubmitting(false);

    if (error) {
      setErrorMessage(error.message);
      return;
    }
    navigation.replace('TourDashboard', { tourId, tourName: name.trim() });
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Name your tour</Text>
      <Text style={styles.subtitle}>
        Dates fill in automatically once you add show dates — nothing to enter here now.
      </Text>

      <TextInput
        style={styles.input}
        placeholder="e.g. Fall Tour 2026"
        placeholderTextColor="#6b6b76"
        value={name}
        onChangeText={setName}
        autoCapitalize="words"
        autoFocus
      />

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <Pressable style={styles.submitButton} onPress={handleSubmit} disabled={submitting}>
        {submitting ? <ActivityIndicator color="#0b0b0f" /> : <Text style={styles.submitButtonText}>Create Tour</Text>}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b0f', justifyContent: 'center', paddingHorizontal: 24 },
  title: { color: '#fff', fontSize: 26, fontWeight: '700', textAlign: 'center' },
  subtitle: { color: '#9a9aa5', fontSize: 14, textAlign: 'center', marginTop: 10, marginBottom: 28, lineHeight: 20 },
  input: {
    backgroundColor: '#1a1a20',
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 16,
    fontSize: 16,
  },
  error: { color: '#ff6b6b', fontSize: 13, marginBottom: 12 },
  submitButton: { backgroundColor: '#fff', borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  submitButtonText: { color: '#0b0b0f', fontSize: 16, fontWeight: '600' },
});