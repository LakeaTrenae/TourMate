/**
 * VenuesScreen — an organization's reusable venue database. Venues are
 * org-scoped, not tour-scoped (see venues.organization_id in 0001_init.sql)
 * — a venue you play this year is worth keeping around for next year's
 * routing, which is why this lives off Settings' org list rather than any
 * single tour.
 */
import { useCallback, useState } from 'react';
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
  TextInput,
  View,
} from 'react-native';

import { supabase } from '../lib/supabase';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Venues'>;

type Venue = {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  capacity: number | null;
  latitude: number | null;
  longitude: number | null;
};

export function VenuesScreen({ route, navigation }: Props) {
  const { organizationId, organizationName } = route.params;

  const [venues, setVenues] = useState<Venue[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function load() {
    const { data, error } = await supabase
      .from('venues')
      .select('id, name, address, city, state, capacity, latitude, longitude')
      .eq('organization_id', organizationId)
      .order('name', { ascending: true });
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    setVenues(data ?? []);
  }

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load().finally(() => setLoading(false));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [organizationId])
  );

  async function handleRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  function confirmDelete(venue: Venue) {
    Alert.alert('Delete this venue?', venue.name, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('venues').delete().eq('id', venue.id);
          if (error) setErrorMessage(error.message);
          else await load();
        },
      },
    ]);
  }

  const filtered = venues.filter((v) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return v.name.toLowerCase().includes(q) || (v.city ?? '').toLowerCase().includes(q);
  });

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
          <Text style={styles.title}>Venues</Text>
          <Text style={styles.subtitle}>{organizationName}</Text>
        </View>
        <Pressable style={styles.addButton} onPress={() => navigation.navigate('AddVenue', { organizationId })}>
          <Text style={styles.addButtonText}>+ Venue</Text>
        </Pressable>
      </View>

      <TextInput
        style={styles.search}
        placeholder="Search name or city"
        placeholderTextColor="#6b6b76"
        value={search}
        onChangeText={setSearch}
      />

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#fff" />}
        contentContainerStyle={filtered.length === 0 && styles.emptyContainer}
      >
        {filtered.length === 0 ? (
          <Text style={styles.emptyText}>{search ? 'No venues match that search.' : 'No venues yet.'}</Text>
        ) : (
          filtered.map((venue) => (
            <Pressable
              key={venue.id}
              style={styles.card}
              onPress={() => navigation.navigate('AddVenue', { organizationId, venueId: venue.id })}
              onLongPress={() => confirmDelete(venue)}
            >
              <Text style={styles.venueName}>{venue.name}</Text>
              <Text style={styles.venueMeta}>
                {[venue.city, venue.state].filter(Boolean).join(', ') || 'No city set'}
                {venue.capacity ? ` · Cap. ${venue.capacity.toLocaleString()}` : ''}
              </Text>
              {!venue.latitude && <Text style={styles.notGeocoded}>Not geocoded — no weather/route data yet</Text>}
            </Pressable>
          ))
        )}
        {filtered.length > 0 && <Text style={styles.hint}>Tap to edit · hold to delete.</Text>}
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
  search: {
    backgroundColor: '#1a1a20',
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    marginBottom: 12,
  },
  error: { color: '#ff6b6b', fontSize: 13, marginBottom: 12 },
  emptyContainer: { flexGrow: 1, justifyContent: 'center' },
  emptyText: { color: '#6b6b76', fontSize: 14, textAlign: 'center' },
  card: { backgroundColor: '#1a1a20', borderRadius: 12, padding: 16, marginBottom: 10 },
  venueName: { color: '#fff', fontSize: 15, fontWeight: '600' },
  venueMeta: { color: '#6b6b76', fontSize: 12, marginTop: 4 },
  notGeocoded: { color: '#e8c274', fontSize: 11, marginTop: 6 },
  hint: { color: '#6b6b76', fontSize: 12, textAlign: 'center', marginTop: 8 },
});
