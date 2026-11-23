/**
 * TravelScreen — flights for this tour.
 *
 * Same pattern as everywhere else: the query just asks for "flights" and
 * "flight_passengers" scoped to this tour, and RLS decides what actually
 * comes back. A manager's query returns every flight on the tour; a crew
 * member's identical query returns only flights they're a passenger on
 * (see "flights readable by assigned passenger" in 0001_init.sql) — this
 * screen doesn't need an if/else for that, the data just arrives already
 * scoped.
 *
 * Grid layout + theme (Manrope/JetBrains Mono, Marquee accent) — see
 * lib/theme.tsx. 2-up via chunkPairs; the departure→arrival route block
 * went from side-by-side to stacked (with a down arrow) at half width,
 * same adaptation as GroundTransportScreen's identical route shape.
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
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Travel'>;

type Flight = {
  id: string;
  airline: string | null;
  flight_number: string | null;
  confirmation_code: string | null;
  departure_airport: string;
  departure_time: string;
  arrival_airport: string;
  arrival_time: string;
  status: string | null;
  status_detail: string | null;
  status_checked_at: string | null;
};

type PassengerRow = { flight_id: string; user_id: string; seat: string | null; profile: { display_name: string } | null };

const MANAGER_TIERS = new Set(['owner', 'admin', 'manager']);

function chunkPairs<T>(items: T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return rows;
}

export function TravelScreen({ route, navigation }: Props) {
  const { tourId, tourName } = route.params;
  const { session } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [isManager, setIsManager] = useState(false);
  const [flights, setFlights] = useState<Flight[]>([]);
  const [passengersByFlight, setPassengersByFlight] = useState<Record<string, PassengerRow[]>>({});
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

    const { data: flightRows, error: flightError } = await supabase
      .from('flights')
      .select(
        'id, airline, flight_number, confirmation_code, departure_airport, departure_time, arrival_airport, arrival_time, status, status_detail, status_checked_at'
      )
      .eq('tour_id', tourId)
      .order('departure_time', { ascending: true });
    if (flightError) {
      setErrorMessage(flightError.message);
      return;
    }
    setFlights(flightRows ?? []);

    const flightIds = (flightRows ?? []).map((f) => f.id);
    if (flightIds.length === 0) {
      setPassengersByFlight({});
      return;
    }
    const { data: passengerRows, error: passengerError } = await supabase
      .from('flight_passengers')
      .select('flight_id, user_id, seat, profile:profiles(display_name)')
      .in('flight_id', flightIds);
    if (passengerError) {
      setErrorMessage(passengerError.message);
      return;
    }
    const grouped: Record<string, PassengerRow[]> = {};
    for (const row of (passengerRows ?? []) as unknown as PassengerRow[]) {
      (grouped[row.flight_id] ??= []).push(row);
    }
    setPassengersByFlight(grouped);
  }

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load().finally(() => setLoading(false));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tourId])
  );

  function formatDateTime(iso: string) {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  async function handleRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  function confirmDelete(flight: Flight) {
    Alert.alert('Delete this flight?', `${flight.airline ?? 'Flight'} ${flight.flight_number ?? ''}`.trim(), [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('flights').delete().eq('id', flight.id);
          if (error) setErrorMessage(error.message);
          else await load();
        },
      },
    ]);
  }

  const sortedFlights = useMemo(() => flights, [flights]);

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
          <Text style={styles.title}>Travel</Text>
          <Text style={styles.subtitle}>{tourName}</Text>
        </View>
        {isManager && (
          <View style={styles.headerActions}>
            <Pressable style={styles.secondaryButton} onPress={() => navigation.navigate('ImportTripit', { tourId })}>
              <Text style={styles.secondaryButtonText}>TripIt</Text>
            </Pressable>
            <Pressable style={styles.addButton} onPress={() => navigation.navigate('AddFlight', { tourId })}>
              <Text style={styles.addButtonText}>+ Flight</Text>
            </Pressable>
          </View>
        )}
      </View>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.accent} />}
        contentContainerStyle={sortedFlights.length === 0 && styles.emptyContainer}
      >
        {sortedFlights.length === 0 ? (
          <Text style={styles.emptyText}>
            {isManager
              ? 'No flights yet. Add one to get started.'
              : "No flights assigned to you yet — you'll only see flights you're booked on."}
          </Text>
        ) : (
          chunkPairs(sortedFlights).map((row, i) => (
            <View key={i} style={styles.row}>
              {row.map((flight) => (
                <Pressable key={flight.id} style={styles.card} onLongPress={isManager ? () => confirmDelete(flight) : undefined}>
                  <View style={styles.cardHeader}>
                    <Text style={styles.airline} numberOfLines={1}>
                      {flight.airline ?? 'Flight'} {flight.flight_number ?? ''}
                    </Text>
                    {isManager && (
                      <Pressable style={styles.deleteButton} onPress={() => confirmDelete(flight)}>
                        <Text style={styles.deleteButtonText}>Delete</Text>
                      </Pressable>
                    )}
                  </View>
                  {(flight.status_detail ?? flight.status) && <Text style={styles.status}>{flight.status_detail ?? flight.status}</Text>}

                  <View style={styles.route}>
                    <View style={styles.leg}>
                      <Text style={styles.airport}>{flight.departure_airport}</Text>
                      <Text style={styles.time}>{formatDateTime(flight.departure_time)}</Text>
                    </View>
                    <Text style={styles.arrow}>↓</Text>
                    <View style={styles.leg}>
                      <Text style={styles.airport}>{flight.arrival_airport}</Text>
                      <Text style={styles.time}>{formatDateTime(flight.arrival_time)}</Text>
                    </View>
                  </View>

                  {flight.confirmation_code && (
                    <Text style={styles.confirmation}>Confirmation: {flight.confirmation_code}</Text>
                  )}

                  {(passengersByFlight[flight.id] ?? []).length > 0 && (
                    <View style={styles.passengers}>
                      {(passengersByFlight[flight.id] ?? []).map((p) => (
                        <Text key={p.user_id} style={styles.passenger} numberOfLines={1}>
                          {p.profile?.display_name ?? 'Unknown'}
                          {p.seat ? ` · Seat ${p.seat}` : ''}
                        </Text>
                      ))}
                    </View>
                  )}
                </Pressable>
              ))}
              {row.length === 1 && <View style={styles.cardSpacer} />}
            </View>
          ))
        )}
        {isManager && sortedFlights.length > 0 && <Text style={styles.hint}>Tap Delete (or hold a flight) to remove it.</Text>}
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
      fontSize: 54,
      fontFamily: fonts.displayBlack,
      letterSpacing: -1.2,
    },
    subtitle: {
      color: colors.textDim,
      fontSize: 16,
      marginTop: 2,
      fontFamily: fonts.body,
    },
    headerActions: { flexDirection: 'row', gap: 8 },
    addButton: {
      backgroundColor: colors.accent,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    addButtonText: {
      color: colors.onAccent,
      fontSize: 16,
      fontFamily: fonts.bodySemiBold,
    },
    secondaryButton: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    secondaryButtonText: { color: colors.accent, fontSize: 16, fontFamily: fonts.bodySemiBold },
    error: {
      color: colors.danger,
      fontSize: 16,
      marginBottom: 12,
      fontFamily: fonts.body,
    },
    emptyContainer: {
      flexGrow: 1,
      justifyContent: 'center',
    },
    emptyText: {
      color: colors.textFaint,
      fontSize: 17,
      textAlign: 'center',
      paddingHorizontal: 20,
      fontFamily: fonts.body,
    },
    row: { flexDirection: 'row', gap: 10, marginBottom: 10 },
    cardSpacer: { flex: 1 },
    card: {
      flex: 1,
      backgroundColor: colors.surface,
      borderRadius: 14,
      padding: 16,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.08,
      shadowRadius: 10,
      elevation: 2,
    },
    cardHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 8,
    },
    deleteButton: { backgroundColor: colors.dangerSoft, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
    deleteButtonText: { color: colors.danger, fontSize: 15, fontFamily: fonts.bodySemiBold },
    airline: {
      color: colors.text,
      fontSize: 18,
      fontFamily: fonts.displaySemiBold,
      flexShrink: 1,
    },
    status: {
      color: colors.warn,
      fontSize: 15,
      fontFamily: fonts.bodySemiBold,
      textTransform: 'uppercase',
      marginTop: 4,
    },
    route: {
      marginTop: 10,
    },
    leg: {},
    airport: {
      color: colors.text,
      fontSize: 20,
      fontFamily: fonts.displayBold,
    },
    time: {
      color: colors.textDim,
      fontSize: 15,
      marginTop: 2,
      fontFamily: fonts.mono,
    },
    arrow: {
      color: colors.textFaint,
      fontSize: 16,
      marginVertical: 4,
    },
    confirmation: {
      color: colors.textFaint,
      fontSize: 15,
      marginTop: 10,
      fontFamily: fonts.mono,
    },
    passengers: {
      marginTop: 10,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingTop: 10,
    },
    passenger: {
      color: colors.textDim,
      fontSize: 16,
      marginTop: 2,
      fontFamily: fonts.body,
    },
    hint: {
      color: colors.textFaint,
      fontSize: 15,
      textAlign: 'center',
      marginTop: 8,
      fontFamily: fonts.body,
    },
  });
}
