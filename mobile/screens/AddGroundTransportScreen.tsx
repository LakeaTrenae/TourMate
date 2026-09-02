/**
 * AddGroundTransportScreen — create a ground transport leg and assign
 * passengers from the tour roster. Structurally identical to
 * AddFlightScreen.tsx (same roster-checkbox pattern), swapped for ground
 * transport's fields. Manager-only via UI convenience; "ground_transport
 * writable by managers" RLS (0023) is the real guard.
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

type Props = NativeStackScreenProps<RootStackParamList, 'AddGroundTransport'>;

export function AddGroundTransportScreen({ route, navigation }: Props) {
  const { tourId } = route.params;
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

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

      <TextInput style={styles.input} placeholder="Vehicle type (bus, van, car)" placeholderTextColor={colors.textFaint} value={vehicleType} onChangeText={setVehicleType} />
      <TextInput style={styles.input} placeholder="Company" placeholderTextColor={colors.textFaint} value={company} onChangeText={setCompany} />
      <View style={styles.row}>
        <TextInput style={[styles.input, styles.rowInput]} placeholder="Driver name" placeholderTextColor={colors.textFaint} value={driverName} onChangeText={setDriverName} />
        <TextInput style={[styles.input, styles.rowInput]} placeholder="Driver phone" placeholderTextColor={colors.textFaint} value={driverPhone} onChangeText={setDriverPhone} keyboardType="phone-pad" />
      </View>
      <TextInput style={styles.input} placeholder="Confirmation code" placeholderTextColor={colors.textFaint} value={confirmationCode} onChangeText={setConfirmationCode} autoCapitalize="characters" />

      <TextInput style={styles.input} placeholder="Pickup location" placeholderTextColor={colors.textFaint} value={pickupLocation} onChangeText={setPickupLocation} />
      <TextInput
        style={styles.input}
        placeholder="Pickup — e.g. 2026-09-10 14:30"
        placeholderTextColor={colors.textFaint}
        value={pickupTime}
        onChangeText={setPickupTime}
      />
      <TextInput style={styles.input} placeholder="Dropoff location" placeholderTextColor={colors.textFaint} value={dropoffLocation} onChangeText={setDropoffLocation} />
      <TextInput
        style={styles.input}
        placeholder="Dropoff — e.g. 2026-09-10 17:45"
        placeholderTextColor={colors.textFaint}
        value={dropoffTime}
        onChangeText={setDropoffTime}
      />
      <TextInput style={styles.input} placeholder="Notes" placeholderTextColor={colors.textFaint} value={notes} onChangeText={setNotes} multiline />

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
        {submitting ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.submitButtonText}>Add Transport</Text>}
      </Pressable>
    </ScrollView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    content: { padding: 20, paddingBottom: 60 },
    title: { color: colors.text, fontSize: 22, fontFamily: fonts.displayBold, marginBottom: 16 },
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
    sectionTitle: { color: colors.text, fontSize: 15, fontFamily: fonts.bodySemiBold, marginTop: 12, marginBottom: 8 },
    emptyText: { color: colors.textFaint, fontSize: 13, fontFamily: fonts.body },
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
    rosterRowSelected: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
    rosterName: { color: colors.text, fontSize: 14, fontFamily: fonts.body },
    rosterCheck: { color: colors.accent, fontSize: 14, fontFamily: fonts.bodyBold },
    error: { color: colors.danger, fontSize: 13, marginTop: 8, marginBottom: 4, fontFamily: fonts.body },
    submitButton: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 16 },
    submitButtonText: { color: colors.onAccent, fontSize: 16, fontFamily: fonts.bodySemiBold },
  });
}
