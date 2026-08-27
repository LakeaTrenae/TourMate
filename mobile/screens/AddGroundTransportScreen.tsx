/**
 * AddGroundTransportScreen — create a ground transport leg and assign
 * passengers from the tour roster. Structurally identical to
 * AddFlightScreen.tsx (same roster-checkbox pattern), swapped for ground
 * transport's fields. Manager-only via UI convenience; "ground_transport
 * writable by managers" RLS (0023) is the real guard.
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
import { fetchTourRoster, type RosterMember } from '../lib/roster';
import { newId } from '../lib/ids';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'AddGroundTransport'>;

export function AddGroundTransportScreen({ route, navigation }: Props) {
  const { tourId } = route.params;

  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [selectedPassengers, setSelectedPassengers] = useState<Set<string>>(new Set());
  const [vehicleType, setVehicleType] = useState('');
  const [company, setCompany] = useState('');
  const [driverName, setDriverName] = useState('');
  const [driverPhone, setDriverPhone] = useState('');
  const [confirmationCode, setConfirmationCode] = useState('');
  const [pickupLocation, setPickupLocation] = useState('');
  const [pickupTime, setPickupTime] = useState('');
  const [dropoffLocation, setDropoffLocation] = useState('');
  const [dropoffTime, setDropoffTime] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    fetchTourRoster(tourId)
      .then(setRoster)
      .catch((err) => setErrorMessage(err.message));
  }, [tourId]);

  function togglePassenger(userId: string) {
    setSelectedPassengers((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  async function handleSubmit() {
    setErrorMessage(null);

    if (!pickupLocation.trim() || !dropoffLocation.trim() || !pickupTime || !dropoffTime) {
      setErrorMessage('Pickup/dropoff locations and times are required.');
      return;
    }
    const pickupDate = new Date(pickupTime);
    const dropoffDate = new Date(dropoffTime);
    if (Number.isNaN(pickupDate.getTime()) || Number.isNaN(dropoffDate.getTime())) {
      setErrorMessage('Enter valid pickup/dropoff date-times, e.g. 2026-09-10 14:30.');
      return;
    }

    setSubmitting(true);

    const legId = newId();
    const { error: legError } = await supabase.from('ground_transport').insert({
      id: legId,
      tour_id: tourId,
      vehicle_type: vehicleType.trim() || null,
      company: company.trim() || null,
      driver_name: driverName.trim() || null,
      driver_phone: driverPhone.trim() || null,
      confirmation_code: confirmationCode.trim() || null,
      pickup_location: pickupLocation.trim(),
      pickup_time: pickupDate.toISOString(),
      dropoff_location: dropoffLocation.trim(),
      dropoff_time: dropoffDate.toISOString(),
      notes: notes.trim() || null,
    });

    if (legError) {
      setSubmitting(false);
      setErrorMessage(legError.message);
      return;
    }

    if (selectedPassengers.size > 0) {
      const { error: passengerError } = await supabase.from('ground_transport_passengers').insert(
        Array.from(selectedPassengers).map((userId) => ({ ground_transport_id: legId, user_id: userId }))
      );
      if (passengerError) {
        setSubmitting(false);
        setErrorMessage(`Leg created, but assigning passengers failed: ${passengerError.message}`);
        return;
      }
    }

    setSubmitting(false);
    navigation.goBack();
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Add Ground Transport</Text>

      <TextInput style={styles.input} placeholder="Vehicle type (bus, van, car)" placeholderTextColor="#6b6b76" value={vehicleType} onChangeText={setVehicleType} />
      <TextInput style={styles.input} placeholder="Company" placeholderTextColor="#6b6b76" value={company} onChangeText={setCompany} />
      <View style={styles.row}>
        <TextInput style={[styles.input, styles.rowInput]} placeholder="Driver name" placeholderTextColor="#6b6b76" value={driverName} onChangeText={setDriverName} />
        <TextInput style={[styles.input, styles.rowInput]} placeholder="Driver phone" placeholderTextColor="#6b6b76" value={driverPhone} onChangeText={setDriverPhone} keyboardType="phone-pad" />
      </View>
      <TextInput style={styles.input} placeholder="Confirmation code" placeholderTextColor="#6b6b76" value={confirmationCode} onChangeText={setConfirmationCode} autoCapitalize="characters" />

      <TextInput style={styles.input} placeholder="Pickup location" placeholderTextColor="#6b6b76" value={pickupLocation} onChangeText={setPickupLocation} />
      <TextInput
        style={styles.input}
        placeholder="Pickup — e.g. 2026-09-10 14:30"
        placeholderTextColor="#6b6b76"
        value={pickupTime}
        onChangeText={setPickupTime}
      />
      <TextInput style={styles.input} placeholder="Dropoff location" placeholderTextColor="#6b6b76" value={dropoffLocation} onChangeText={setDropoffLocation} />
      <TextInput
        style={styles.input}
        placeholder="Dropoff — e.g. 2026-09-10 17:45"
        placeholderTextColor="#6b6b76"
        value={dropoffTime}
        onChangeText={setDropoffTime}
      />
      <TextInput style={styles.input} placeholder="Notes" placeholderTextColor="#6b6b76" value={notes} onChangeText={setNotes} multiline />

      <Text style={styles.sectionTitle}>Passengers</Text>
      {roster.length === 0 && <Text style={styles.emptyText}>No one on the roster yet.</Text>}
      {roster.map((member) => {
        const selected = selectedPassengers.has(member.user_id);
        return (
          <Pressable
            key={member.user_id}
            style={[styles.rosterRow, selected && styles.rosterRowSelected]}
            onPress={() => togglePassenger(member.user_id)}
          >
            <Text style={styles.rosterName}>{member.display_name}</Text>
            <Text style={styles.rosterCheck}>{selected ? '✓' : ''}</Text>
          </Pressable>
        );
      })}

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <Pressable style={styles.submitButton} onPress={handleSubmit} disabled={submitting}>
        {submitting ? <ActivityIndicator color="#0b0b0f" /> : <Text style={styles.submitButtonText}>Add Transport</Text>}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b0f' },
  content: { padding: 20, paddingBottom: 60 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700', marginBottom: 16 },
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
  sectionTitle: { color: '#fff', fontSize: 15, fontWeight: '600', marginTop: 12, marginBottom: 8 },
  emptyText: { color: '#6b6b76', fontSize: 13 },
  rosterRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: '#1a1a20',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 6,
  },
  rosterRowSelected: { backgroundColor: '#2a2a3a' },
  rosterName: { color: '#fff', fontSize: 14 },
  rosterCheck: { color: '#7c9cff', fontSize: 14, fontWeight: '700' },
  error: { color: '#ff6b6b', fontSize: 13, marginTop: 8, marginBottom: 4 },
  submitButton: { backgroundColor: '#fff', borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 16 },
  submitButtonText: { color: '#0b0b0f', fontSize: 16, fontWeight: '600' },
});
