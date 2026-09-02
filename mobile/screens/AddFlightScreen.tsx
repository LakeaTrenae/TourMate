/**
 * AddFlightScreen — create a flight and assign passengers from the tour
 * roster. Only reachable via the "+ Flight" button on TravelScreen, which
 * is itself only shown to manager-tier users — but that's a UI
 * convenience, not the actual guard. The real guard is the "flights
 * writable by managers" / "flight_passengers writable by managers" RLS
 * policies: if a crew member somehow landed on this screen and hit
 * submit, the insert would just fail server-side.
 *
 * Theme (Manrope/JetBrains Mono, navy accent) per the "Load-In" design
 * review — see lib/theme.tsx.
 */
import { useEffect, useMemo, useState } from 'react';
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
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'AddFlight'>;

export function AddFlightScreen({ route, navigation }: Props) {
  const { tourId } = route.params;
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

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

      <TextInput style={styles.input} placeholder="Airline" placeholderTextColor={colors.textFaint} value={airline} onChangeText={setAirline} />
      <TextInput style={styles.input} placeholder="Flight number" placeholderTextColor={colors.textFaint} value={flightNumber} onChangeText={setFlightNumber} autoCapitalize="characters" />
      <TextInput style={styles.input} placeholder="Confirmation code" placeholderTextColor={colors.textFaint} value={confirmationCode} onChangeText={setConfirmationCode} autoCapitalize="characters" />

      <View style={styles.row}>
        <TextInput
          style={[styles.input, styles.rowInput]}
          placeholder="Departure airport (JFK)"
          placeholderTextColor={colors.textFaint}
          value={departureAirport}
          onChangeText={setDepartureAirport}
          autoCapitalize="characters"
          maxLength={4}
        />
        <TextInput
          style={[styles.input, styles.rowInput]}
          placeholder="Arrival airport (LAX)"
          placeholderTextColor={colors.textFaint}
          value={arrivalAirport}
          onChangeText={setArrivalAirport}
          autoCapitalize="characters"
          maxLength={4}
        />
      </View>

      <TextInput
        style={styles.input}
        placeholder="Departure — e.g. 2026-09-10 14:30"
        placeholderTextColor={colors.textFaint}
        value={departureTime}
        onChangeText={setDepartureTime}
      />
      <TextInput
        style={styles.input}
        placeholder="Arrival — e.g. 2026-09-10 17:45"
        placeholderTextColor={colors.textFaint}
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
        {submitting ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.submitButtonText}>Add Flight</Text>}
      </Pressable>
    </ScrollView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.bg,
    },
    content: {
      padding: 20,
      paddingBottom: 60,
    },
    title: {
      color: colors.text,
      fontSize: 22,
      fontFamily: fonts.displayBold,
      marginBottom: 16,
    },
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
    row: {
      flexDirection: 'row',
      gap: 10,
    },
    rowInput: {
      flex: 1,
    },
    sectionTitle: {
      color: colors.text,
      fontSize: 15,
      fontFamily: fonts.bodySemiBold,
      marginTop: 12,
      marginBottom: 8,
    },
    emptyText: {
      color: colors.textFaint,
      fontSize: 13,
      fontFamily: fonts.body,
    },
    rosterRow: {
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
    rosterRowSelected: {
      backgroundColor: colors.accentSoft,
      borderColor: colors.accent,
    },
    rosterName: {
      color: colors.text,
      fontSize: 14,
      fontFamily: fonts.body,
    },
    rosterCheck: {
      color: colors.accent,
      fontSize: 14,
      fontFamily: fonts.bodyBold,
    },
    error: {
      color: colors.danger,
      fontSize: 13,
      marginTop: 8,
      marginBottom: 4,
      fontFamily: fonts.body,
    },
    submitButton: {
      backgroundColor: colors.accent,
      borderRadius: 10,
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: 16,
    },
    submitButtonText: {
      color: colors.onAccent,
      fontSize: 16,
      fontFamily: fonts.bodySemiBold,
    },
  });
}
