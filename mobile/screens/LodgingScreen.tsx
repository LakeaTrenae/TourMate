/**
 * LodgingScreen — hotel bookings and room assignments for this tour.
 *
 * Same RLS-does-the-filtering pattern as TravelScreen: a manager's query
 * returns every lodging entry and every room; a crew member's identical
 * query returns only the room(s) they're actually assigned to (see
 * "lodging_rooms readable by assigned occupant" in 0002_policy_gaps.sql).
 *
 * Theme (Manrope/JetBrains Mono, navy accent) per the "Load-In" design
 * review — see lib/theme.tsx.
 */
import { useCallback, useMemo, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { formatDateOnly } from '../lib/dates';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Lodging'>;

type Lodging = {
  id: string;
  hotel_name: string;
  address: string | null;
  check_in: string | null;
  check_out: string | null;
  confirmation_code: string | null;
};

type Room = { id: string; lodging_id: string; room_number: string | null; notes: string | null };
type Occupant = { room_id: string; user_id: string; profile: { display_name: string } | null };

const MANAGER_TIERS = new Set(['owner', 'admin', 'manager']);

export function LodgingScreen({ route, navigation }: Props) {
  const { tourId, tourName } = route.params;
  const { session } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [isManager, setIsManager] = useState(false);
  const [lodgings, setLodgings] = useState<Lodging[]>([]);
  const [roomsByLodging, setRoomsByLodging] = useState<Record<string, Room[]>>({});
  const [occupantsByRoom, setOccupantsByRoom] = useState<Record<string, Occupant[]>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function load() {
    if (!session) return;

    const { data: roleData } = await supabase.rpc('effective_tour_role', {
      p_tour_id: tourId,
      p_user_id: session.user.id,
    });
    setIsManager(roleData ? MANAGER_TIERS.has(roleData) : false);

    const { data: lodgingRows, error: lodgingError } = await supabase
      .from('lodging')
      .select('id, hotel_name, address, check_in, check_out, confirmation_code')
      .eq('tour_id', tourId)
      .order('check_in', { ascending: true });
    if (lodgingError) {
      setErrorMessage(lodgingError.message);
      return;
    }
    setLodgings(lodgingRows ?? []);

    const lodgingIds = (lodgingRows ?? []).map((l) => l.id);
    if (lodgingIds.length === 0) {
      setRoomsByLodging({});
      setOccupantsByRoom({});
      return;
    }

    const { data: roomRows, error: roomError } = await supabase
      .from('lodging_rooms')
      .select('id, lodging_id, room_number, notes')
      .in('lodging_id', lodgingIds);
    if (roomError) {
      setErrorMessage(roomError.message);
      return;
    }
    const roomsGrouped: Record<string, Room[]> = {};
    for (const room of roomRows ?? []) {
      (roomsGrouped[room.lodging_id] ??= []).push(room);
    }
    setRoomsByLodging(roomsGrouped);

    const roomIds = (roomRows ?? []).map((r) => r.id);
    if (roomIds.length === 0) {
      setOccupantsByRoom({});
      return;
    }
    const { data: occupantRows, error: occupantError } = await supabase
      .from('lodging_room_occupants')
      .select('room_id, user_id, profile:profiles(display_name)')
      .in('room_id', roomIds);
    if (occupantError) {
      setErrorMessage(occupantError.message);
      return;
    }
    const occupantsGrouped: Record<string, Occupant[]> = {};
    for (const occ of (occupantRows ?? []) as unknown as Occupant[]) {
      (occupantsGrouped[occ.room_id] ??= []).push(occ);
    }
    setOccupantsByRoom(occupantsGrouped);
  }

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load().finally(() => setLoading(false));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tourId])
  );

  async function handleRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  function formatDate(dateStr: string | null) {
    if (!dateStr) return 'TBD';
    return formatDateOnly(dateStr, { month: 'short', day: 'numeric' });
  }

  function confirmDelete(lodging: Lodging) {
    Alert.alert('Delete this hotel?', lodging.hotel_name, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('lodging').delete().eq('id', lodging.id);
          if (error) setErrorMessage(error.message);
          else await load();
        },
      },
    ]);
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Lodging</Text>
          <Text style={styles.subtitle}>{tourName}</Text>
        </View>
        {isManager && (
          <Pressable style={styles.addButton} onPress={() => navigation.navigate('AddLodging', { tourId })}>
            <Text style={styles.addButtonText}>+ Hotel</Text>
          </Pressable>
        )}
      </View>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.accent} />}
        contentContainerStyle={lodgings.length === 0 && styles.emptyContainer}
      >
        {lodgings.length === 0 ? (
          <Text style={styles.emptyText}>
            {isManager
              ? 'No hotels added yet.'
              : "No room assigned to you yet — you'll only see hotels where you have a room."}
          </Text>
        ) : (
          lodgings.map((lodging) => (
            <Pressable
              key={lodging.id}
              style={styles.card}
              onLongPress={isManager ? () => confirmDelete(lodging) : undefined}
            >
              <View style={styles.cardHeader}>
                <Text style={styles.hotelName}>{lodging.hotel_name}</Text>
                {isManager && (
                  <Pressable style={styles.deleteButton} onPress={() => confirmDelete(lodging)}>
                    <Text style={styles.deleteButtonText}>Delete</Text>
                  </Pressable>
                )}
              </View>
              {lodging.address && <Text style={styles.address}>{lodging.address}</Text>}
              <Text style={styles.dates}>
                {formatDate(lodging.check_in)} – {formatDate(lodging.check_out)}
              </Text>
              {lodging.confirmation_code && (
                <Text style={styles.confirmation}>Confirmation: {lodging.confirmation_code}</Text>
              )}

              <View style={styles.rooms}>
                {(roomsByLodging[lodging.id] ?? []).map((room) => (
                  <View key={room.id} style={styles.room}>
                    <Text style={styles.roomNumber}>Room {room.room_number ?? '—'}</Text>
                    {(occupantsByRoom[room.id] ?? []).map((occ) => (
                      <Text key={occ.user_id} style={styles.occupant}>
                        {occ.profile?.display_name ?? 'Unknown'}
                      </Text>
                    ))}
                  </View>
                ))}
              </View>
            </Pressable>
          ))
        )}
        {isManager && lodgings.length > 0 && <Text style={styles.hint}>Tap Delete (or hold a hotel) to remove it.</Text>}
      </ScrollView>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.bg,
      paddingTop: 20,
      paddingHorizontal: 20,
    },
    centered: {
      flex: 1,
      backgroundColor: colors.bg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      marginBottom: 16,
    },
    title: {
      color: colors.text,
      fontSize: 26,
      fontFamily: fonts.displayBlack,
      letterSpacing: -0.4,
    },
    subtitle: {
      color: colors.textDim,
      fontSize: 13,
      marginTop: 2,
      fontFamily: fonts.body,
    },
    addButton: {
      backgroundColor: colors.accent,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    addButtonText: {
      color: colors.onAccent,
      fontSize: 13,
      fontFamily: fonts.bodySemiBold,
    },
    error: {
      color: colors.danger,
      fontSize: 13,
      marginBottom: 12,
      fontFamily: fonts.body,
    },
    emptyContainer: {
      flexGrow: 1,
      justifyContent: 'center',
    },
    emptyText: {
      color: colors.textFaint,
      fontSize: 14,
      textAlign: 'center',
      paddingHorizontal: 20,
      fontFamily: fonts.body,
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 14,
      padding: 16,
      marginBottom: 12,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.08,
      shadowRadius: 10,
      elevation: 2,
    },
    hotelName: {
      color: colors.text,
      fontSize: 16,
      fontFamily: fonts.displaySemiBold,
    },
    cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    deleteButton: { backgroundColor: colors.dangerSoft, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
    deleteButtonText: { color: colors.danger, fontSize: 12, fontFamily: fonts.bodySemiBold },
    address: {
      color: colors.textDim,
      fontSize: 13,
      marginTop: 2,
      fontFamily: fonts.body,
    },
    dates: {
      color: colors.textFaint,
      fontSize: 13,
      marginTop: 6,
      fontFamily: fonts.mono,
    },
    confirmation: {
      color: colors.textFaint,
      fontSize: 12,
      marginTop: 4,
      fontFamily: fonts.mono,
    },
    rooms: {
      marginTop: 10,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingTop: 10,
    },
    room: {
      marginBottom: 8,
    },
    roomNumber: {
      color: colors.text,
      fontSize: 13,
      fontFamily: fonts.bodySemiBold,
    },
    occupant: {
      color: colors.textDim,
      fontSize: 13,
      marginLeft: 8,
      marginTop: 2,
      fontFamily: fonts.body,
    },
    hint: {
      color: colors.textFaint,
      fontSize: 12,
      textAlign: 'center',
      marginTop: 8,
      fontFamily: fonts.body,
    },
  });
}
