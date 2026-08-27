/**
 * AddLodgingScreen — create a hotel booking, then add one or more rooms
 * under it, each with its own occupants picked from the tour roster.
 *
 * Same guard note as AddFlightScreen: only reachable via the manager-only
 * "+ Hotel" button, but the real enforcement is server-side RLS
 * ("lodging writable by managers" etc, 0002_policy_gaps.sql) — this
 * screen's own logic isn't what's protecting the data.
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

type Props = NativeStackScreenProps<RootStackParamList, 'AddLodging'>;

type DraftRoom = {
  key: string;
  roomNumber: string;
  occupantIds: Set<string>;
};

export function AddLodgingScreen({ route, navigation }: Props) {
  const { tourId } = route.params;

  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [hotelName, setHotelName] = useState('');
  const [address, setAddress] = useState('');
  const [checkIn, setCheckIn] = useState('');
  const [checkOut, setCheckOut] = useState('');
  const [confirmationCode, setConfirmationCode] = useState('');
  const [rooms, setRooms] = useState<DraftRoom[]>([{ key: cryptoRandomKey(), roomNumber: '', occupantIds: new Set() }]);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    fetchTourRoster(tourId)
      .then(setRoster)
      .catch((err) => setErrorMessage(err.message));
  }, [tourId]);

  function addRoom() {
    setRooms((prev) => [...prev, { key: cryptoRandomKey(), roomNumber: '', occupantIds: new Set() }]);
  }

  function removeRoom(key: string) {
    setRooms((prev) => prev.filter((r) => r.key !== key));
  }

  function updateRoomNumber(key: string, roomNumber: string) {
    setRooms((prev) => prev.map((r) => (r.key === key ? { ...r, roomNumber } : r)));
  }

  function toggleOccupant(key: string, userId: string) {
    setRooms((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r;
        const next = new Set(r.occupantIds);
        if (next.has(userId)) next.delete(userId);
        else next.add(userId);
        return { ...r, occupantIds: next };
      })
    );
  }

  async function handleSubmit() {
    setErrorMessage(null);

    if (!hotelName.trim()) {
      setErrorMessage('Hotel name is required.');
      return;
    }

    setSubmitting(true);

    // Client-generated ids throughout this screen, not .select() chained
    // onto the inserts — see lib/ids.ts for why (a confirmed RLS/
    // RETURNING interaction on any trigger-bearing table, which lodging
    // and lodging_rooms both are via the completion-lock trigger).
    const lodgingId = newId();
    const { error: lodgingError } = await supabase.from('lodging').insert({
      id: lodgingId,
      tour_id: tourId,
      hotel_name: hotelName.trim(),
      address: address.trim() || null,
      check_in: checkIn.trim() || null,
      check_out: checkOut.trim() || null,
      confirmation_code: confirmationCode.trim() || null,
    });

    if (lodgingError) {
      setSubmitting(false);
      setErrorMessage(lodgingError.message);
      return;
    }

    // Rooms and occupants go in sequentially (not Promise.all) so a
    // failure partway through points at a specific room instead of
    // surfacing as one opaque batch error.
    for (const room of rooms) {
      if (!room.roomNumber.trim() && room.occupantIds.size === 0) continue; // skip fully-empty rows

      const roomId = newId();
      const { error: roomError } = await supabase
        .from('lodging_rooms')
        .insert({ id: roomId, lodging_id: lodgingId, room_number: room.roomNumber.trim() || null });

      if (roomError) {
        setSubmitting(false);
        setErrorMessage(`Hotel created, but room "${room.roomNumber || '(unnumbered)'}" failed: ${roomError.message}`);
        return;
      }

      if (room.occupantIds.size > 0) {
        const { error: occupantError } = await supabase.from('lodging_room_occupants').insert(
          Array.from(room.occupantIds).map((userId) => ({ room_id: roomId, user_id: userId }))
        );
        if (occupantError) {
          setSubmitting(false);
          setErrorMessage(`Room created, but assigning occupants failed: ${occupantError.message}`);
          return;
        }
      }
    }

    setSubmitting(false);
    navigation.goBack();
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Add Hotel</Text>

      <TextInput style={styles.input} placeholder="Hotel name" placeholderTextColor="#6b6b76" value={hotelName} onChangeText={setHotelName} />
      <TextInput style={styles.input} placeholder="Address" placeholderTextColor="#6b6b76" value={address} onChangeText={setAddress} />
      <View style={styles.row}>
        <TextInput
          style={[styles.input, styles.rowInput]}
          placeholder="Check-in (2026-09-10)"
          placeholderTextColor="#6b6b76"
          value={checkIn}
          onChangeText={setCheckIn}
        />
        <TextInput
          style={[styles.input, styles.rowInput]}
          placeholder="Check-out (2026-09-12)"
          placeholderTextColor="#6b6b76"
          value={checkOut}
          onChangeText={setCheckOut}
        />
      </View>
      <TextInput style={styles.input} placeholder="Confirmation code" placeholderTextColor="#6b6b76" value={confirmationCode} onChangeText={setConfirmationCode} autoCapitalize="characters" />

      <Text style={styles.sectionTitle}>Rooms</Text>
      {rooms.map((room, index) => (
        <View key={room.key} style={styles.roomBlock}>
          <View style={styles.roomBlockHeader}>
            <TextInput
              style={[styles.input, styles.roomNumberInput]}
              placeholder={`Room ${index + 1} number`}
              placeholderTextColor="#6b6b76"
              value={room.roomNumber}
              onChangeText={(v) => updateRoomNumber(room.key, v)}
            />
            {rooms.length > 1 && (
              <Pressable onPress={() => removeRoom(room.key)} style={styles.removeButton}>
                <Text style={styles.removeButtonText}>Remove</Text>
              </Pressable>
            )}
          </View>
          {roster.map((member) => {
            const selected = room.occupantIds.has(member.user_id);
            return (
              <Pressable
                key={member.user_id}
                style={[styles.rosterRow, selected && styles.rosterRowSelected]}
                onPress={() => toggleOccupant(room.key, member.user_id)}
              >
                <Text style={styles.rosterName}>{member.display_name}</Text>
                <Text style={styles.rosterCheck}>{selected ? '✓' : ''}</Text>
              </Pressable>
            );
          })}
        </View>
      ))}

      <Pressable onPress={addRoom} style={styles.addRoomButton}>
        <Text style={styles.addRoomButtonText}>+ Add another room</Text>
      </Pressable>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <Pressable style={styles.submitButton} onPress={handleSubmit} disabled={submitting}>
        {submitting ? <ActivityIndicator color="#0b0b0f" /> : <Text style={styles.submitButtonText}>Add Hotel</Text>}
      </Pressable>
    </ScrollView>
  );
}

/** Local-only draft key for list rendering — never sent to the server, so
 *  a simple random string is fine here (unlike real ids, which come from
 *  Postgres's gen_random_uuid()). */
function cryptoRandomKey() {
  return Math.random().toString(36).slice(2);
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
  roomBlock: {
    backgroundColor: '#15151a',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  roomBlockHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  roomNumberInput: {
    flex: 1,
    marginBottom: 8,
  },
  removeButton: {
    marginBottom: 8,
  },
  removeButtonText: {
    color: '#ff6b6b',
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
  addRoomButton: {
    alignItems: 'center',
    paddingVertical: 10,
    marginBottom: 8,
  },
  addRoomButtonText: {
    color: '#9a9aa5',
    fontSize: 13,
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
