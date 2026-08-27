/**
 * AddTourDateScreen — creates a show date (tour_dates row) for the tour.
 * This is the prerequisite the Guest List feature attaches to — every
 * guest list request belongs to a specific tour_date.
 *
 * Also the entry point for a venue (venues are org-scoped and reusable
 * across tours, see venues.organization_id in 0001_init.sql — so this
 * screen resolves tourId → organization_id first, then lets you pick an
 * existing venue or jump to AddVenueScreen to create one; returning here
 * re-fetches the venue list via useFocusEffect so a freshly-created venue
 * shows up immediately) and the show-details fields added in
 * 0022_venues_geo_and_show_details.sql (status/promoter/guarantee/ticket
 * price/capacity override).
 *
 * Manager-only via UI convenience; "tour_dates writable by managers" RLS
 * (0001_init.sql) is what actually enforces it.
 */
import { useCallback, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
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
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'AddTourDate'>;

type Venue = { id: string; name: string; city: string | null };
type ShowStatus = 'confirmed' | 'hold' | 'cancelled' | 'postponed';
const SHOW_STATUSES: { value: ShowStatus; label: string }[] = [
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'hold', label: 'Hold' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'postponed', label: 'Postponed' },
];

export function AddTourDateScreen({ route, navigation }: Props) {
  const { tourId } = route.params;

  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [venues, setVenues] = useState<Venue[]>([]);
  const [venueId, setVenueId] = useState<string | null>(null);

  const [date, setDate] = useState('');
  const [loadIn, setLoadIn] = useState('');
  const [soundcheck, setSoundcheck] = useState('');
  const [doors, setDoors] = useState('');
  const [setTime, setSetTime] = useState('');
  const [notes, setNotes] = useState('');
  const [showStatus, setShowStatus] = useState<ShowStatus>('confirmed');
  const [promoterName, setPromoterName] = useState('');
  const [promoterPhone, setPromoterPhone] = useState('');
  const [promoterEmail, setPromoterEmail] = useState('');
  const [guarantee, setGuarantee] = useState('');
  const [ticketPrice, setTicketPrice] = useState('');
  const [capacityOverride, setCapacityOverride] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      supabase
        .from('tours')
        .select('organization_id')
        .eq('id', tourId)
        .single()
        .then(({ data, error }) => {
          if (error || !data) return;
          setOrganizationId(data.organization_id);
          return supabase
            .from('venues')
            .select('id, name, city')
            .eq('organization_id', data.organization_id)
            .order('name', { ascending: true });
        })
        .then((result) => {
          if (result && !result.error) setVenues(result.data ?? []);
        });
    }, [tourId])
  );

  async function handleSubmit() {
    setErrorMessage(null);

    if (!date.trim() || Number.isNaN(new Date(date).getTime())) {
      setErrorMessage('Enter a valid date, e.g. 2026-09-10.');
      return;
    }

    setSubmitting(true);
    const { error } = await supabase.from('tour_dates').insert({
      tour_id: tourId,
      venue_id: venueId,
      date: date.trim(),
      load_in: loadIn.trim() || null,
      soundcheck: soundcheck.trim() || null,
      doors: doors.trim() || null,
      set_time: setTime.trim() || null,
      notes: notes.trim() || null,
      show_status: showStatus,
      promoter_name: promoterName.trim() || null,
      promoter_phone: promoterPhone.trim() || null,
      promoter_email: promoterEmail.trim() || null,
      guarantee: guarantee.trim() ? Number.parseFloat(guarantee) : null,
      ticket_price: ticketPrice.trim() ? Number.parseFloat(ticketPrice) : null,
      capacity_override: capacityOverride.trim() ? Number.parseInt(capacityOverride, 10) : null,
    });
    setSubmitting(false);

    if (error) {
      setErrorMessage(error.message);
      return;
    }
    navigation.goBack();
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Add Show Date</Text>

      <TextInput style={styles.input} placeholder="Date — e.g. 2026-09-10" placeholderTextColor="#6b6b76" value={date} onChangeText={setDate} />

      <Text style={styles.sectionTitle}>Venue</Text>
      <View style={styles.chipRow}>
        <Pressable style={[styles.chip, venueId === null && styles.chipActive]} onPress={() => setVenueId(null)}>
          <Text style={[styles.chipText, venueId === null && styles.chipTextActive]}>None</Text>
        </Pressable>
        {venues.map((v) => (
          <Pressable key={v.id} style={[styles.chip, venueId === v.id && styles.chipActive]} onPress={() => setVenueId(v.id)}>
            <Text style={[styles.chipText, venueId === v.id && styles.chipTextActive]}>
              {v.name}
              {v.city ? ` · ${v.city}` : ''}
            </Text>
          </Pressable>
        ))}
        {organizationId && (
          <Pressable
            style={styles.newVenueChip}
            onPress={() => navigation.navigate('AddVenue', { organizationId })}
          >
            <Text style={styles.newVenueChipText}>+ New venue</Text>
          </Pressable>
        )}
      </View>

      <Text style={styles.sectionTitle}>Status</Text>
      <View style={styles.chipRow}>
        {SHOW_STATUSES.map((s) => (
          <Pressable key={s.value} style={[styles.chip, showStatus === s.value && styles.chipActive]} onPress={() => setShowStatus(s.value)}>
            <Text style={[styles.chipText, showStatus === s.value && styles.chipTextActive]}>{s.label}</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.row}>
        <TextInput style={[styles.input, styles.rowInput]} placeholder="Load-in (14:00)" placeholderTextColor="#6b6b76" value={loadIn} onChangeText={setLoadIn} />
        <TextInput style={[styles.input, styles.rowInput]} placeholder="Soundcheck (16:00)" placeholderTextColor="#6b6b76" value={soundcheck} onChangeText={setSoundcheck} />
      </View>
      <View style={styles.row}>
        <TextInput style={[styles.input, styles.rowInput]} placeholder="Doors (19:00)" placeholderTextColor="#6b6b76" value={doors} onChangeText={setDoors} />
        <TextInput style={[styles.input, styles.rowInput]} placeholder="Set time (20:30)" placeholderTextColor="#6b6b76" value={setTime} onChangeText={setSetTime} />
      </View>

      <Text style={styles.sectionTitle}>Promoter</Text>
      <TextInput style={styles.input} placeholder="Promoter name" placeholderTextColor="#6b6b76" value={promoterName} onChangeText={setPromoterName} />
      <View style={styles.row}>
        <TextInput style={[styles.input, styles.rowInput]} placeholder="Phone" placeholderTextColor="#6b6b76" value={promoterPhone} onChangeText={setPromoterPhone} keyboardType="phone-pad" />
        <TextInput style={[styles.input, styles.rowInput]} placeholder="Email" placeholderTextColor="#6b6b76" value={promoterEmail} onChangeText={setPromoterEmail} autoCapitalize="none" keyboardType="email-address" />
      </View>

      <Text style={styles.sectionTitle}>Deal</Text>
      <View style={styles.row}>
        <TextInput style={[styles.input, styles.rowInput]} placeholder="Guarantee ($)" placeholderTextColor="#6b6b76" value={guarantee} onChangeText={setGuarantee} keyboardType="decimal-pad" />
        <TextInput style={[styles.input, styles.rowInput]} placeholder="Ticket price ($)" placeholderTextColor="#6b6b76" value={ticketPrice} onChangeText={setTicketPrice} keyboardType="decimal-pad" />
      </View>
      <TextInput style={styles.input} placeholder="Capacity override" placeholderTextColor="#6b6b76" value={capacityOverride} onChangeText={setCapacityOverride} keyboardType="number-pad" />

      <TextInput style={styles.input} placeholder="Notes" placeholderTextColor="#6b6b76" value={notes} onChangeText={setNotes} multiline />

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <Pressable style={styles.submitButton} onPress={handleSubmit} disabled={submitting}>
        {submitting ? <ActivityIndicator color="#0b0b0f" /> : <Text style={styles.submitButtonText}>Add Date</Text>}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b0f' },
  content: { padding: 20, paddingBottom: 60 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700', marginBottom: 16 },
  sectionTitle: { color: '#9a9aa5', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', marginTop: 14, marginBottom: 8 },
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
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  chip: { backgroundColor: '#1a1a20', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 },
  chipActive: { backgroundColor: '#fff' },
  chipText: { color: '#9a9aa5', fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: '#0b0b0f' },
  newVenueChip: {
    backgroundColor: '#15151a',
    borderWidth: 1,
    borderColor: '#2a2a32',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  newVenueChipText: { color: '#7c9cff', fontSize: 13, fontWeight: '600' },
  error: { color: '#ff6b6b', fontSize: 13, marginTop: 8, marginBottom: 4 },
  submitButton: {
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 16,
  },
  submitButtonText: { color: '#0b0b0f', fontSize: 16, fontWeight: '600' },
});
