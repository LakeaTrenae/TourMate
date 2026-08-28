/**
 * GroundTransportScreen — buses/vans/cars for this tour, structurally a
 * clone of TravelScreen.tsx now that ground_transport mirrors flights at
 * the schema/RLS level (0023_ground_transport_advancing_settlement.sql).
 * Same RLS-does-the-filtering pattern: a manager's query returns every
 * leg on the tour; a crew member's identical query returns only legs
 * they're a passenger on ("ground_transport readable by assigned
 * passenger").
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

type Props = NativeStackScreenProps<RootStackParamList, 'GroundTransport'>;

type Leg = {
  id: string;
  vehicle_type: string | null;
  company: string | null;
  driver_name: string | null;
  driver_phone: string | null;
  pickup_location: string;
  pickup_time: string;
  dropoff_location: string;
  dropoff_time: string;
  confirmation_code: string | null;
};

type PassengerRow = { ground_transport_id: string; user_id: string; seat: string | null; profile: { display_name: string } | null };

const MANAGER_TIERS = new Set(['owner', 'admin', 'manager']);

export function GroundTransportScreen({ route, navigation }: Props) {
  const { tourId, tourName } = route.params;
  const { session } = useAuth();

  const [isManager, setIsManager] = useState(false);
  const [legs, setLegs] = useState<Leg[]>([]);
  const [passengersByLeg, setPassengersByLeg] = useState<Record<string, PassengerRow[]>>({});
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

    const { data: legRows, error: legError } = await supabase
      .from('ground_transport')
      .select('id, vehicle_type, company, driver_name, driver_phone, pickup_location, pickup_time, dropoff_location, dropoff_time, confirmation_code')
      .eq('tour_id', tourId)
      .order('pickup_time', { ascending: true });
    if (legError) {
      setErrorMessage(legError.message);
      return;
    }
    setLegs(legRows ?? []);

    const legIds = (legRows ?? []).map((l) => l.id);
    if (legIds.length === 0) {
      setPassengersByLeg({});
      return;
    }
    const { data: passengerRows, error: passengerError } = await supabase
      .from('ground_transport_passengers')
      .select('ground_transport_id, user_id, seat, profile:profiles(display_name)')
      .in('ground_transport_id', legIds);
    if (passengerError) {
      setErrorMessage(passengerError.message);
      return;
    }
    const grouped: Record<string, PassengerRow[]> = {};
    for (const row of (passengerRows ?? []) as unknown as PassengerRow[]) {
      (grouped[row.ground_transport_id] ??= []).push(row);
    }
    setPassengersByLeg(grouped);
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

  function confirmDelete(leg: Leg) {
    Alert.alert('Delete this leg?', `${leg.vehicle_type ?? 'Transport'} — ${leg.pickup_location}`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('ground_transport').delete().eq('id', leg.id);
          if (error) setErrorMessage(error.message);
          else await load();
        },
      },
    ]);
  }

  const sortedLegs = useMemo(() => legs, [legs]);

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
          <Text style={styles.title}>Ground Transport</Text>
          <Text style={styles.subtitle}>{tourName}</Text>
        </View>
        {isManager && (
          <Pressable style={styles.addButton} onPress={() => navigation.navigate('AddGroundTransport', { tourId })}>
            <Text style={styles.addButtonText}>+ Add</Text>
          </Pressable>
        )}
      </View>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#fff" />}
        contentContainerStyle={sortedLegs.length === 0 && styles.emptyContainer}
      >
        {sortedLegs.length === 0 ? (
          <Text style={styles.emptyText}>
            {isManager
              ? 'No ground transport yet. Add a bus, van, or car to get started.'
              : "No ground transport assigned to you yet — you'll only see legs you're booked on."}
          </Text>
        ) : (
          sortedLegs.map((leg) => (
            <Pressable
              key={leg.id}
              style={styles.card}
              onLongPress={isManager ? () => confirmDelete(leg) : undefined}
            >
              <View style={styles.cardHeader}>
                <Text style={styles.vehicle}>{leg.vehicle_type ?? 'Transport'}{leg.company ? ` · ${leg.company}` : ''}</Text>
                {isManager && (
                  <Pressable style={styles.deleteButton} onPress={() => confirmDelete(leg)}>
                    <Text style={styles.deleteButtonText}>Delete</Text>
                  </Pressable>
                )}
              </View>

              <View style={styles.route}>
                <View style={styles.leg}>
                  <Text style={styles.location}>{leg.pickup_location}</Text>
                  <Text style={styles.time}>{formatDateTime(leg.pickup_time)}</Text>
                </View>
                <Text style={styles.arrow}>→</Text>
                <View style={styles.leg}>
                  <Text style={styles.location}>{leg.dropoff_location}</Text>
                  <Text style={styles.time}>{formatDateTime(leg.dropoff_time)}</Text>
                </View>
              </View>

              {leg.driver_name && (
                <Text style={styles.driver}>
                  Driver: {leg.driver_name}
                  {leg.driver_phone ? ` · ${leg.driver_phone}` : ''}
                </Text>
              )}
              {leg.confirmation_code && <Text style={styles.confirmation}>Confirmation: {leg.confirmation_code}</Text>}

              <View style={styles.passengers}>
                {(passengersByLeg[leg.id] ?? []).map((p) => (
                  <Text key={p.user_id} style={styles.passenger}>
                    {p.profile?.display_name ?? 'Unknown'}
                    {p.seat ? ` · Seat ${p.seat}` : ''}
                  </Text>
                ))}
              </View>
            </Pressable>
          ))
        )}
        {isManager && sortedLegs.length > 0 && <Text style={styles.hint}>Tap Delete (or hold a leg) to remove it.</Text>}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b0f', paddingTop: 20, paddingHorizontal: 20 },
  centered: { flex: 1, backgroundColor: '#0b0b0f', alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 },
  title: { color: '#fff', fontSize: 24, fontWeight: '700' },
  subtitle: { color: '#6b6b76', fontSize: 13, marginTop: 2 },
  addButton: { backgroundColor: '#fff', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  addButtonText: { color: '#0b0b0f', fontSize: 13, fontWeight: '600' },
  error: { color: '#ff6b6b', fontSize: 13, marginBottom: 12 },
  emptyContainer: { flexGrow: 1, justifyContent: 'center' },
  emptyText: { color: '#6b6b76', fontSize: 14, textAlign: 'center', paddingHorizontal: 20 },
  card: { backgroundColor: '#1a1a20', borderRadius: 12, padding: 16, marginBottom: 12 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  vehicle: { color: '#fff', fontSize: 15, fontWeight: '600' },
  deleteButton: { backgroundColor: '#3a1e1e', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  deleteButtonText: { color: '#ff6b6b', fontSize: 12, fontWeight: '600' },
  route: { flexDirection: 'row', alignItems: 'center' },
  leg: { flex: 1 },
  location: { color: '#fff', fontSize: 15, fontWeight: '700' },
  time: { color: '#9a9aa5', fontSize: 12, marginTop: 2 },
  arrow: { color: '#6b6b76', fontSize: 16, marginHorizontal: 10 },
  driver: { color: '#9a9aa5', fontSize: 12, marginTop: 10 },
  confirmation: { color: '#6b6b76', fontSize: 12, marginTop: 4 },
  passengers: { marginTop: 10, borderTopWidth: 1, borderTopColor: '#2a2a32', paddingTop: 10 },
  passenger: { color: '#9a9aa5', fontSize: 13, marginTop: 2 },
  hint: { color: '#6b6b76', fontSize: 12, textAlign: 'center', marginTop: 8 },
});
