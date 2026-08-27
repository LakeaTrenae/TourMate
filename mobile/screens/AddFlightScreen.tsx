/**
 * AddFlightScreen — create a flight and assign passengers from the tour
 * roster. Only reachable via the "+ Flight" button on TravelScreen, which
 * is itself only shown to manager-tier users — but that's a UI
 * convenience, not the actual guard. The real guard is the "flights
 * writable by managers" / "flight_passengers writable by managers" RLS
 * policies: if a crew member somehow landed on this screen and hit
 * submit, the insert would just fail server-side.
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

type Props = NativeStackScreenProps<RootStackParamList, 'AddFlight'>;

export function AddFlightScreen({ route, navigation }: Props) {
  const { tourId } = route.params;

  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [selectedPassengers, setSelectedPassengers] = useState<Set<string>>(new Set());
  const [airline, setAirline] = useState('');
  const [flightNumber, setFlightNumber] = useState('');
  const [confirmationCode, setConfirmationCode] = useState('');
  const [departureAirport, setDepartureAirport] = useState('');
  const [departureTime, setDepartureTime] = useState('');
  const [arrivalAirport, setArrivalAirport] = useState('');
  const [arrivalTime, setArrivalTime] = useState('');
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

    if (!departureAirport.trim() || !arrivalAirport.trim() || !departureTime || !arrivalTime) {
      setErrorMessage('Departure/arrival airports and times are required.');
      return;
    }
    // Basic sanity check on the datetime inputs before they ever reach the
    // database — not a substitute for the column type itself rejecting
    // malformed values, just a clearer error than a raw Postgres one.
    const depDate = new Date(departureTime);
    const arrDate = new Date(arrivalTime);
    if (Number.isNaN(depDate.getTime()) || Number.isNaN(arrDate.getTime())) {
      setErrorMessage('Enter valid departure/arrival date-times, e.g. 2026-09-10 14:30.');
      return;
    }

    setSubmitting(true);

    // Generate the flight's id ourselves instead of chaining .select() onto
    // the insert to read it back — see lib/ids.ts for why (a real,
    // confirmed RLS/RETURNING interaction on any trigger-bearing table,
    // which `flights` is, via the completion-lock trigger).
    const flightId = newId();
    const { error: flightError } = await supabase.from('flights').insert({
      id: flightId,
      tour_id: tourId,
      airline: airline.trim() || null,
      flight_number: flightNumber.trim() || null,
      confirmation_code: confirmationCode.trim() || null,
      departure_airport: departureAirport.trim().toUpperCase(),
      departure_time: depDate.toISOString(),
      arrival_airport: arrivalAirport.trim().toUpperCase(),
      arrival_time: arrDate.toISOString(),
    });

    if (flightError) {
      setSubmitting(false);
      setErrorMessage(flightError.message);
      return;
    }

    if (selectedPassengers.size > 0) {
      const { error: passengerError } = await supabase.from('flight_passengers').insert(
        Array.from(selectedPassengers).map((userId) => ({ flight_id: flightId, user_id: userId }))
      );
      if (passengerError) {
        setSubmitting(false);
        setErrorMessage(`Flight created, but assigning passengers failed: ${passengerError.message}`);
        return;
      }
    }

    setSubmitting(false);
    navigation.goBack();
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Add Flight</Text>

      <TextInput style={styles.input} placeholder="Airline" placeholderTextColor="#6b6b76" value={airline} onChangeText={setAirline} />
      <TextInput style={styles.input} placeholder="Flight number" placeholderTextColor="#6b6b76" value={flightNumber} onChangeText={setFlightNumber} autoCapitalize="characters" />
      <TextInput style={styles.input} placeholder="Confirmation code" placeholderTextColor="#6b6b76" value={confirmationCode} onChangeText={setConfirmationCode} autoCapitalize="characters" />

      <View style={styles.row}>
        <TextInput
          style={[styles.input, styles.rowInput]}
          placeholder="Departure airport (JFK)"
          placeholderTextColor="#6b6b76"
          value={departureAirport}
          onChangeText={setDepartureAirport}
          autoCapitalize="characters"
          maxLength={4}
        />
        <TextInput
          style={[styles.input, styles.rowInput]}
          placeholder="Arrival airport (LAX)"
          placeholderTextColor="#6b6b76"
          value={arrivalAirport}
          onChangeText={setArrivalAirport}
          autoCapitalize="characters"
          maxLength={4}
        />
      </View>

      <TextInput
        style={styles.input}
        placeholder="Departure — e.g. 2026-09-10 14:30"
        placeholderTextColor="#6b6b76"
        value={departureTime}
        onChangeText={setDepartureTime}
      />
      <TextInput
        style={styles.input}
        placeholder="Arrival — e.g. 2026-09-10 17:45"
        placeholderTextColor="#6b6b76"
        value={arrivalTime}
        onChangeText={setArrivalTime}
      />

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
        {submitting ? <ActivityIndicator color="#0b0b0f" /> : <Text style={styles.submitButtonText}>Add Flight</Text>}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b0b0f',
  },
  content: {
    padding: 20,
    paddingBottom: 60,
  },
  title: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 16,
  },
  input: {
    backgroundColor: '#1a1a20',
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 10,
    fontSize: 15,
  },
  row: {
    flexDirection: 'row',
    gap: 10,
  },
  rowInput: {
    flex: 1,
  },
  sectionTitle: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    marginTop: 12,
    marginBottom: 8,
  },
  emptyText: {
    color: '#6b6b76',
    fontSize: 13,
  },
  rosterRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: '#1a1a20',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 6,
  },
  rosterRowSelected: {
    backgroundColor: '#2a2a3a',
  },
  rosterName: {
    color: '#fff',
    fontSize: 14,
  },
  rosterCheck: {
    color: '#7c9cff',
    fontSize: 14,
    fontWeight: '700',
  },
  error: {
    color: '#ff6b6b',
    fontSize: 13,
    marginTop: 8,
    marginBottom: 4,
  },
  submitButton: {
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 16,
  },
  submitButtonText: {
    color: '#0b0b0f',
    fontSize: 16,
    fontWeight: '600',
  },
});
