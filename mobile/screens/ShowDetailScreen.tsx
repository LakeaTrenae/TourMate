/**
 * ShowDetailScreen — the hub for one show date. Everything that's
 * specific to a single date but didn't fit on the tour-wide dashboard
 * lands here: status/promoter/deal terms (0022), a weather chip (via
 * lib/geo's keyless Open-Meteo lookup, silently omitted for dates outside
 * the ~16-day forecast horizon), and links out to that date's Advance
 * sheet and (manager-only) Settlement.
 */
import { useCallback, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Print from 'expo-print';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { formatDateOnly } from '../lib/dates';
import { fetchForecast, weatherCodeLabel, type ForecastResult } from '../lib/geo';
import { buildDaySheetHtml } from '../lib/dayPrint';
import { newId } from '../lib/ids';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'ShowDetail'>;

type ShowDetail = {
  date: string;
  tour: { name: string } | null;
  load_in: string | null;
  soundcheck: string | null;
  doors: string | null;
  set_time: string | null;
  notes: string | null;
  show_status: 'confirmed' | 'hold' | 'cancelled' | 'postponed';
  promoter_name: string | null;
  promoter_phone: string | null;
  promoter_email: string | null;
  guarantee: number | null;
  ticket_price: number | null;
  capacity_override: number | null;
  venue: {
    id: string;
    name: string;
    address: string | null;
    city: string | null;
    state: string | null;
    capacity: number | null;
    latitude: number | null;
    longitude: number | null;
  } | null;
};

type VenuePhoto = { id: string; url: string };
type DressingRoom = { id: string; room_name: string; artist_id: string | null; notes: string | null; artist: { name: string } | null };
type ArtistOption = { id: string; name: string };

const MANAGER_TIERS = new Set(['owner', 'admin', 'manager']);
const STATUS_COLORS: Record<string, string> = {
  confirmed: '#7ee787',
  hold: '#e8c274',
  cancelled: '#ff6b6b',
  postponed: '#e8c274',
};

export function ShowDetailScreen({ route, navigation }: Props) {
  const { tourId, tourDateId } = route.params;
  const { session } = useAuth();

  const [show, setShow] = useState<ShowDetail | null>(null);
  const [isManager, setIsManager] = useState(false);
  const [canManageRooms, setCanManageRooms] = useState(false);
  const [forecast, setForecast] = useState<ForecastResult | null>(null);
  const [photos, setPhotos] = useState<VenuePhoto[]>([]);
  const [dressingRooms, setDressingRooms] = useState<DressingRoom[]>([]);
  const [artistOptions, setArtistOptions] = useState<ArtistOption[]>([]);
  const [approvedGuestCount, setApprovedGuestCount] = useState(0);
  const [showAddRoom, setShowAddRoom] = useState(false);
  const [newRoomName, setNewRoomName] = useState('');
  const [addingRoom, setAddingRoom] = useState(false);
  const [assigningRoomId, setAssigningRoomId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function load() {
    if (session) {
      const [{ data: roleData }, { data: deptData }] = await Promise.all([
        supabase.rpc('effective_tour_role', { p_tour_id: tourId, p_user_id: session.user.id }),
        supabase.rpc('department_on_tour', { p_tour_id: tourId, p_user_id: session.user.id }),
      ]);
      setIsManager(roleData ? MANAGER_TIERS.has(roleData) : false);
      setCanManageRooms((roleData ? MANAGER_TIERS.has(roleData) : false) || deptData === 'production');
    }

    const { data, error } = await supabase
      .from('tour_dates')
      .select(
        'date, load_in, soundcheck, doors, set_time, notes, show_status, promoter_name, promoter_phone, promoter_email, guarantee, ticket_price, capacity_override, tour:tours(name), venue:venues(id, name, address, city, state, capacity, latitude, longitude)'
      )
      .eq('id', tourDateId)
      .single();

    if (error) {
      setErrorMessage(error.message);
      return;
    }
    const showRow = data as unknown as ShowDetail;
    setShow(showRow);

    const venue = showRow.venue;
    if (venue?.latitude != null && venue?.longitude != null) {
      const result = await fetchForecast(venue.latitude, venue.longitude, showRow.date);
      setForecast(result);
    } else {
      setForecast(null);
    }

    if (venue?.id) {
      const { data: photoRows } = await supabase
        .from('venue_photos')
        .select('id, storage_path')
        .eq('venue_id', venue.id)
        .order('created_at', { ascending: true });
      const withUrls = await Promise.all(
        (photoRows ?? []).map(async (p) => {
          const { data: signed } = await supabase.storage.from('venue-photos').createSignedUrl(p.storage_path, 60 * 60);
          return { id: p.id, url: signed?.signedUrl ?? '' };
        })
      );
      setPhotos(withUrls.filter((p) => p.url));
    } else {
      setPhotos([]);
    }

    // RLS already scopes this to what the current user can see — a crew
    // member with no team assignment gets back only rooms assigned to an
    // artist they're on the team for (or none at all), a manager gets
    // everything (0027). No client-side filtering needed on top of that.
    const { data: roomRows, error: roomError } = await supabase
      .from('dressing_rooms')
      .select('id, room_name, artist_id, notes, artist:artists(name)')
      .eq('tour_date_id', tourDateId)
      .order('room_name', { ascending: true });
    if (roomError) setErrorMessage(roomError.message);
    setDressingRooms((roomRows ?? []) as unknown as DressingRoom[]);

    const { data: artistRows } = await supabase.from('artists').select('id, name').eq('tour_id', tourId).order('name', { ascending: true });
    setArtistOptions(artistRows ?? []);

    // Same "approved only" reasoning as GuestListScreen's capacityWarning —
    // pending requests haven't actually been let in yet.
    const { data: guestRows } = await supabase
      .from('guest_list_requests')
      .select('guest_count')
      .eq('tour_date_id', tourDateId)
      .eq('status', 'approved');
    setApprovedGuestCount((guestRows ?? []).reduce((sum, r) => sum + r.guest_count, 0));
  }

  async function handleAddRoom() {
    if (!newRoomName.trim()) return;
    setErrorMessage(null);
    setAddingRoom(true);
    const { error } = await supabase.from('dressing_rooms').insert({
      id: newId(),
      tour_date_id: tourDateId,
      room_name: newRoomName.trim(),
    });
    setAddingRoom(false);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    setNewRoomName('');
    setShowAddRoom(false);
    await load();
  }

  async function handleAssignArtist(roomId: string, artistId: string | null) {
    setErrorMessage(null);
    const { error } = await supabase.from('dressing_rooms').update({ artist_id: artistId }).eq('id', roomId);
    setAssigningRoomId(null);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    await load();
  }

  function confirmDeleteRoom(room: DressingRoom) {
    Alert.alert('Remove this dressing room?', room.room_name, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('dressing_rooms').delete().eq('id', room.id);
          if (error) setErrorMessage(error.message);
          else await load();
        },
      },
    ]);
  }

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load().finally(() => setLoading(false));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tourDateId])
  );

  async function handlePrint() {
    if (!show) return;
    try {
      await Print.printAsync({
        html: buildDaySheetHtml({
          tourName: show.tour?.name ?? '',
          dateLabel: formatDateOnly(show.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
          showStatus: show.show_status,
          venueName: show.venue?.name ?? null,
          venueAddress: [show.venue?.address, show.venue?.city, show.venue?.state].filter(Boolean).join(', ') || null,
          loadIn: show.load_in,
          soundcheck: show.soundcheck,
          doors: show.doors,
          setTime: show.set_time,
          promoterName: show.promoter_name,
          promoterPhone: show.promoter_phone,
          promoterEmail: show.promoter_email,
          notes: show.notes,
        }),
      });
    } catch (err) {
      Alert.alert('Print failed', err instanceof Error ? err.message : 'Something went wrong.');
    }
  }

  if (loading || !show) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  const dateLabel = formatDateOnly(show.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const capacity = show.capacity_override ?? show.venue?.capacity ?? null;
  const capacityWarning =
    capacity && approvedGuestCount >= capacity * 0.9
      ? `${approvedGuestCount} / ${capacity} approved — ${approvedGuestCount >= capacity ? 'at or over capacity' : 'approaching capacity'}`
      : null;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <Text style={styles.dateLabel}>{dateLabel}</Text>
      <View style={styles.statusRow}>
        <Text style={[styles.statusBadge, { color: STATUS_COLORS[show.show_status] }]}>{show.show_status.toUpperCase()}</Text>
        {forecast && (
          <Text style={styles.weather}>
            {Math.round(forecast.tempHighF)}° / {Math.round(forecast.tempLowF)}°F · {weatherCodeLabel(forecast.weatherCode)}
          </Text>
        )}
      </View>

      {show.venue ? (
        <View style={styles.card}>
          <Text style={styles.venueName}>{show.venue.name}</Text>
          <Text style={styles.venueMeta}>
            {[show.venue.city, show.venue.state].filter(Boolean).join(', ') || 'No location set'}
            {(show.capacity_override ?? show.venue.capacity)
              ? ` · Cap. ${(show.capacity_override ?? show.venue.capacity)!.toLocaleString()}`
              : ''}
          </Text>
          {capacityWarning && <Text style={styles.capacityWarning}>{capacityWarning}</Text>}
          {photos.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.photoRow} contentContainerStyle={styles.photoRowContent}>
              {photos.map((photo) => (
                <Image key={photo.id} source={{ uri: photo.url }} style={styles.photoThumb} />
              ))}
            </ScrollView>
          )}
        </View>
      ) : (
        <Text style={styles.emptyText}>No venue set for this date yet.</Text>
      )}

      {(dressingRooms.length > 0 || canManageRooms) && (
        <View style={styles.card}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>Dressing Rooms</Text>
            {canManageRooms && (
              <Pressable onPress={() => setShowAddRoom((v) => !v)}>
                <Text style={styles.sectionAction}>{showAddRoom ? 'Cancel' : '+ Add'}</Text>
              </Pressable>
            )}
          </View>
          <Text style={styles.privacyNote}>
            Visible only to tour management and each room's assigned artist team — that's the point.
          </Text>

          {showAddRoom && (
            <View style={styles.addRoomRow}>
              <TextInput
                style={styles.addRoomInput}
                placeholder="Room name (e.g. Room A)"
                placeholderTextColor="#6b6b76"
                value={newRoomName}
                onChangeText={setNewRoomName}
              />
              <Pressable style={styles.addRoomButton} onPress={handleAddRoom} disabled={addingRoom || !newRoomName.trim()}>
                {addingRoom ? <ActivityIndicator color="#0b0b0f" /> : <Text style={styles.addRoomButtonText}>Add</Text>}
              </Pressable>
            </View>
          )}

          {dressingRooms.length === 0 ? (
            <Text style={styles.emptyText}>No dressing rooms added yet.</Text>
          ) : (
            dressingRooms.map((room) => (
              <View key={room.id} style={styles.roomRow}>
                <Pressable
                  style={styles.roomInfo}
                  onLongPress={canManageRooms ? () => confirmDeleteRoom(room) : undefined}
                >
                  <Text style={styles.roomName}>{room.room_name}</Text>
                  <Text style={styles.roomArtist}>{room.artist?.name ?? 'Unassigned'}</Text>
                </Pressable>
                {canManageRooms &&
                  (assigningRoomId === room.id ? (
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.artistChipRow}>
                      <Pressable style={styles.artistChip} onPress={() => handleAssignArtist(room.id, null)}>
                        <Text style={styles.artistChipText}>None</Text>
                      </Pressable>
                      {artistOptions.map((a) => (
                        <Pressable key={a.id} style={styles.artistChip} onPress={() => handleAssignArtist(room.id, a.id)}>
                          <Text style={styles.artistChipText}>{a.name}</Text>
                        </Pressable>
                      ))}
                    </ScrollView>
                  ) : (
                    <View style={styles.roomActions}>
                      <Pressable onPress={() => setAssigningRoomId(room.id)}>
                        <Text style={styles.sectionAction}>Assign</Text>
                      </Pressable>
                      <Pressable style={styles.deleteButton} onPress={() => confirmDeleteRoom(room)}>
                        <Text style={styles.deleteButtonText}>Delete</Text>
                      </Pressable>
                    </View>
                  ))}
              </View>
            ))
          )}
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Schedule</Text>
        <TimeRow label="Load-in" value={show.load_in} />
        <TimeRow label="Soundcheck" value={show.soundcheck} />
        <TimeRow label="Doors" value={show.doors} />
        <TimeRow label="Set time" value={show.set_time} />
      </View>

      {(show.promoter_name || show.promoter_phone || show.promoter_email) && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Promoter</Text>
          {show.promoter_name && <Text style={styles.detailText}>{show.promoter_name}</Text>}
          {show.promoter_phone && <Text style={styles.detailText}>{show.promoter_phone}</Text>}
          {show.promoter_email && <Text style={styles.detailText}>{show.promoter_email}</Text>}
        </View>
      )}

      {(show.guarantee != null || show.ticket_price != null) && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Deal</Text>
          {show.guarantee != null && <Text style={styles.detailText}>Guarantee: ${show.guarantee.toLocaleString()}</Text>}
          {show.ticket_price != null && <Text style={styles.detailText}>Ticket price: ${show.ticket_price.toFixed(2)}</Text>}
        </View>
      )}

      {show.notes && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Notes</Text>
          <Text style={styles.detailText}>{show.notes}</Text>
        </View>
      )}

      <View style={styles.actions}>
        <Pressable
          style={styles.actionButton}
          onPress={() => navigation.navigate('Advance', { tourId, tourDateId, tourDateLabel: dateLabel })}
        >
          <Text style={styles.actionButtonText}>Advance</Text>
        </Pressable>
        {isManager && (
          <Pressable
            style={styles.actionButton}
            onPress={() => navigation.navigate('Settlement', { tourId, tourDateId, tourDateLabel: dateLabel })}
          >
            <Text style={styles.actionButtonText}>Settlement</Text>
          </Pressable>
        )}
      </View>
      <Pressable style={styles.printButton} onPress={handlePrint}>
        <Text style={styles.printButtonText}>Print Day Sheet</Text>
      </Pressable>
    </ScrollView>
  );
}

function TimeRow({ label, value }: { label: string; value: string | null }) {
  return (
    <View style={styles.timeRow}>
      <Text style={styles.timeLabel}>{label}</Text>
      <Text style={styles.timeValue}>{value ?? '—'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b0f' },
  centered: { flex: 1, backgroundColor: '#0b0b0f', alignItems: 'center', justifyContent: 'center' },
  content: { padding: 20, paddingBottom: 60 },
  error: { color: '#ff6b6b', fontSize: 13, marginBottom: 12 },
  dateLabel: { color: '#fff', fontSize: 20, fontWeight: '700' },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, marginBottom: 16 },
  statusBadge: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5 },
  weather: { color: '#9a9aa5', fontSize: 13 },
  emptyText: { color: '#6b6b76', fontSize: 14, marginBottom: 12 },
  card: { backgroundColor: '#1a1a20', borderRadius: 12, padding: 16, marginBottom: 12 },
  venueName: { color: '#fff', fontSize: 17, fontWeight: '700' },
  venueMeta: { color: '#9a9aa5', fontSize: 13, marginTop: 4 },
  capacityWarning: { color: '#e8c274', fontSize: 12, fontWeight: '600', marginTop: 6 },
  photoRow: { flexGrow: 0, marginTop: 12 },
  photoRowContent: { gap: 8 },
  photoThumb: { width: 96, height: 96, borderRadius: 10, backgroundColor: '#0b0b0f' },
  sectionTitle: { color: '#9a9aa5', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', marginBottom: 10 },
  sectionHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  sectionAction: { color: '#7c9cff', fontSize: 13, fontWeight: '600' },
  roomActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  deleteButton: { backgroundColor: '#3a1e1e', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  deleteButtonText: { color: '#ff6b6b', fontSize: 12, fontWeight: '600' },
  privacyNote: { color: '#6b6b76', fontSize: 11, marginBottom: 10, fontStyle: 'italic' },
  addRoomRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  addRoomInput: {
    flex: 1,
    backgroundColor: '#0b0b0f',
    color: '#fff',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  addRoomButton: { backgroundColor: '#fff', borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center' },
  addRoomButtonText: { color: '#0b0b0f', fontSize: 13, fontWeight: '600' },
  roomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#2a2a32',
    paddingTop: 10,
    marginTop: 10,
  },
  roomInfo: { flex: 1 },
  roomName: { color: '#fff', fontSize: 14, fontWeight: '600' },
  roomArtist: { color: '#9a9aa5', fontSize: 12, marginTop: 2 },
  artistChipRow: { flexGrow: 0, maxWidth: 220 },
  artistChip: { backgroundColor: '#0b0b0f', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6, marginRight: 6 },
  artistChipText: { color: '#7c9cff', fontSize: 12, fontWeight: '600' },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  timeLabel: { color: '#6b6b76', fontSize: 13 },
  timeValue: { color: '#fff', fontSize: 13 },
  detailText: { color: '#fff', fontSize: 14, marginTop: 2 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 8 },
  actionButton: { flex: 1, backgroundColor: '#fff', borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  actionButtonText: { color: '#0b0b0f', fontSize: 15, fontWeight: '600' },
  printButton: {
    borderWidth: 1,
    borderColor: '#2a2a32',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 10,
  },
  printButtonText: { color: '#9a9aa5', fontSize: 14, fontWeight: '600' },
});
