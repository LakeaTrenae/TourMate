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
};

type PassengerRow = { flight_id: string; user_id: string; seat: string | null; profile: { display_name: string } | null };

const MANAGER_TIERS = new Set(['owner', 'admin', 'manager']);

export function TravelScreen({ route, navigation }: Props) {
  const { tourId, tourName } = route.params;
  const { session } = useAuth();

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
      .select('id, airline, flight_number, confirmation_code, departure_airport, departure_time, arrival_airport, arrival_time, status')
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
        <ActivityIndicator color="#fff" />
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
          <Pressable style={styles.addButton} onPress={() => navigation.navigate('AddFlight', { tourId })}>
            <Text style={styles.addButtonText}>+ Flight</Text>
          </Pressable>
        )}
      </View>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#fff" />}
        contentContainerStyle={sortedFlights.length === 0 && styles.emptyContainer}
      >
        {sortedFlights.length === 0 ? (
          <Text style={styles.emptyText}>
            {isManager
              ? 'No flights yet. Add one to get started.'
              : "No flights assigned to you yet — you'll only see flights you're booked on."}
          </Text>
        ) : (
          sortedFlights.map((flight) => (
            <Pressable
              key={flight.id}
              style={styles.card}
              onLongPress={isManager ? () => confirmDelete(flight) : undefined}
            >
              <View style={styles.cardHeader}>
                <Text style={styles.airline}>
                  {flight.airline ?? 'Flight'} {flight.flight_number ?? ''}
                </Text>
                {flight.status && <Text style={styles.status}>{flight.status}</Text>}
              </View>

              <View style={styles.route}>
                <View style={styles.leg}>
                  <Text style={styles.airport}>{flight.departure_airport}</Text>
                  <Text style={styles.time}>{formatDateTime(flight.departure_time)}</Text>
                </View>
                <Text style={styles.arrow}>→</Text>
                <View style={styles.leg}>
                  <Text style={styles.airport}>{flight.arrival_airport}</Text>
                  <Text style={styles.time}>{formatDateTime(flight.arrival_time)}</Text>
                </View>
              </View>

              {flight.confirmation_code && (
                <Text style={styles.confirmation}>Confirmation: {flight.confirmation_code}</Text>
              )}

              <View style={styles.passengers}>
                {(passengersByFlight[flight.id] ?? []).map((p) => (
                  <Text key={p.user_id} style={styles.passenger}>
                    {p.profile?.display_name ?? 'Unknown'}
                    {p.seat ? ` · Seat ${p.seat}` : ''}
                  </Text>
                ))}
              </View>
            </Pressable>
          ))
        )}
        {isManager && sortedFlights.length > 0 && <Text style={styles.hint}>Hold a flight to delete it.</Text>}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b0b0f',
    paddingTop: 20,
    paddingHorizontal: 20,
  },
  centered: {
    flex: 1,
    backgroundColor: '#0b0b0f',
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
    color: '#fff',
    fontSize: 24,
    fontWeight: '700',
  },
  subtitle: {
    color: '#6b6b76',
    fontSize: 13,
    marginTop: 2,
  },
  addButton: {
    backgroundColor: '#fff',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  addButtonText: {
    color: '#0b0b0f',
    fontSize: 13,
    fontWeight: '600',
  },
  error: {
    color: '#ff6b6b',
    fontSize: 13,
    marginBottom: 12,
  },
  emptyContainer: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  emptyText: {
    color: '#6b6b76',
    fontSize: 14,
    textAlign: 'center',
    paddingHorizontal: 20,
  },
  card: {
    backgroundColor: '#1a1a20',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  airline: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  status: {
    color: '#e8c274',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  route: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  leg: {
    flex: 1,
  },
  airport: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  time: {
    color: '#9a9aa5',
    fontSize: 12,
    marginTop: 2,
  },
  arrow: {
    color: '#6b6b76',
    fontSize: 16,
    marginHorizontal: 10,
  },
  confirmation: {
    color: '#6b6b76',
    fontSize: 12,
    marginTop: 10,
  },
  passengers: {
    marginTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#2a2a32',
    paddingTop: 10,
  },
  passenger: {
    color: '#9a9aa5',
    fontSize: 13,
    marginTop: 2,
  },
  hint: {
    color: '#6b6b76',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 8,
  },
});
