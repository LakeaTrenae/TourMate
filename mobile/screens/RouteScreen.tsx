/**
 * RouteScreen — the tour's shows in date order, with the straight-line
 * (Haversine) distance from each show to the next. Explicitly not a real
 * driving route — no routing/maps API is involved, just great-circle
 * math on venue lat/lng (lib/geo.ts) — so this is labeled as an estimate
 * throughout rather than implying turn-by-turn accuracy it doesn't have.
 * A show whose venue has no coordinates yet (never geocoded, or no venue
 * set at all) just shows "—" for its distance rather than breaking the
 * chain for shows around it.
 */
import { useCallback, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { supabase } from '../lib/supabase';
import { formatDateOnly } from '../lib/dates';
import { haversineDistanceMiles } from '../lib/geo';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Route'>;

type Stop = {
  id: string;
  date: string;
  venueName: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
};

export function RouteScreen({ route, navigation }: Props) {
  const { tourId, tourName } = route.params;

  const [stops, setStops] = useState<Stop[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function load() {
    const { data, error } = await supabase
      .from('tour_dates')
      .select('id, date, venue:venues(name, city, latitude, longitude)')
      .eq('tour_id', tourId)
      .order('date', { ascending: true });

    if (error) {
      setErrorMessage(error.message);
      return;
    }

    setStops(
      ((data ?? []) as unknown as { id: string; date: string; venue: { name: string; city: string | null; latitude: number | null; longitude: number | null } | null }[]).map(
        (row) => ({
          id: row.id,
          date: row.date,
          venueName: row.venue?.name ?? null,
          city: row.venue?.city ?? null,
          latitude: row.venue?.latitude ?? null,
          longitude: row.venue?.longitude ?? null,
        })
      )
    );
  }

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load().finally(() => setLoading(false));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tourId])
  );

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
        <Text style={styles.title}>Route</Text>
        <Text style={styles.subtitle}>{tourName}</Text>
      </View>
      <Text style={styles.disclaimer}>Estimated straight-line distance between shows — not a driving route.</Text>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <ScrollView contentContainerStyle={stops.length === 0 && styles.emptyContainer}>
        {stops.length === 0 ? (
          <Text style={styles.emptyText}>No show dates yet.</Text>
        ) : (
          stops.map((stop, index) => {
            const prev = index > 0 ? stops[index - 1] : null;
            let distanceLabel: string | null = null;
            if (prev && prev.latitude != null && prev.longitude != null && stop.latitude != null && stop.longitude != null) {
              const miles = haversineDistanceMiles(prev.latitude, prev.longitude, stop.latitude, stop.longitude);
              distanceLabel = `${Math.round(miles).toLocaleString()} mi from previous`;
            }
            return (
              <View key={stop.id}>
                {index > 0 && (
                  <View style={styles.connector}>
                    <View style={styles.connectorLine} />
                    <Text style={styles.connectorText}>{distanceLabel ?? '— mi (missing coordinates)'}</Text>
                  </View>
                )}
                <Pressable style={styles.card} onPress={() => navigation.navigate('ShowDetail', { tourId, tourDateId: stop.id })}>
                  <Text style={styles.dateLabel}>{formatDateOnly(stop.date, { weekday: 'short', month: 'short', day: 'numeric' })}</Text>
                  <Text style={styles.venueLabel}>{stop.venueName ?? 'No venue set'}</Text>
                  {stop.city && <Text style={styles.cityLabel}>{stop.city}</Text>}
                </Pressable>
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b0f', paddingTop: 20, paddingHorizontal: 20 },
  centered: { flex: 1, backgroundColor: '#0b0b0f', alignItems: 'center', justifyContent: 'center' },
  header: { marginBottom: 4 },
  title: { color: '#fff', fontSize: 24, fontWeight: '700' },
  subtitle: { color: '#6b6b76', fontSize: 13, marginTop: 2 },
  disclaimer: { color: '#6b6b76', fontSize: 12, marginBottom: 16, fontStyle: 'italic' },
  error: { color: '#ff6b6b', fontSize: 13, marginBottom: 12 },
  emptyContainer: { flexGrow: 1, justifyContent: 'center' },
  emptyText: { color: '#6b6b76', fontSize: 14, textAlign: 'center' },
  card: { backgroundColor: '#1a1a20', borderRadius: 12, padding: 16 },
  dateLabel: { color: '#9a9aa5', fontSize: 12, fontWeight: '600', textTransform: 'uppercase' },
  venueLabel: { color: '#fff', fontSize: 16, fontWeight: '700', marginTop: 4 },
  cityLabel: { color: '#6b6b76', fontSize: 13, marginTop: 2 },
  connector: { alignItems: 'center', paddingVertical: 6 },
  connectorLine: { width: 1, height: 14, backgroundColor: '#2a2a32' },
  connectorText: { color: '#6b6b76', fontSize: 11, marginTop: 2 },
});
