/**
 * RouteScreen — the tour's shows in date order, with the straight-line
 * (Haversine) distance from each show to the next. Explicitly not a real
 * driving route — no routing/maps API is involved, just great-circle
 * math on venue lat/lng (lib/geo.ts) — so this is labeled as an estimate
 * throughout rather than implying turn-by-turn accuracy it doesn't have.
 * A show whose venue has no coordinates yet (never geocoded, or no venue
 * set at all) just shows "—" for its distance rather than breaking the
 * chain for shows around it.
 *
 * Theme (Manrope/JetBrains Mono, navy accent) per the "Load-In" design
 * review — see lib/theme.tsx.
 */
import { useCallback, useMemo, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { supabase } from '../lib/supabase';
import { formatDateOnly } from '../lib/dates';
import { haversineDistanceMiles } from '../lib/geo';
import { buildRouteMapHtml } from '../lib/routeMapHtml';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
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
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [stops, setStops] = useState<Stop[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showMap, setShowMap] = useState(false);

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
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Route</Text>
          <Text style={styles.subtitle}>{tourName}</Text>
        </View>
        {stops.length > 0 && (
          <Pressable style={styles.toggleButton} onPress={() => setShowMap((v) => !v)}>
            <Text style={styles.toggleButtonText}>{showMap ? 'List View' : 'Map View'}</Text>
          </Pressable>
        )}
      </View>
      <Text style={styles.disclaimer}>Estimated straight-line distance between shows — not a driving route.</Text>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      {showMap && stops.length > 0 ? (
        <View style={styles.mapContainer}>
          <WebView
            source={{
              html: buildRouteMapHtml(
                stops
                  .filter((s): s is Stop & { latitude: number; longitude: number } => s.latitude != null && s.longitude != null)
                  .map((s) => ({
                    label: `${formatDateOnly(s.date, { month: 'short', day: 'numeric' })} — ${s.venueName ?? 'No venue set'}`,
                    latitude: s.latitude,
                    longitude: s.longitude,
                  }))
              ),
            }}
            style={styles.map}
          />
          {stops.some((s) => s.latitude == null || s.longitude == null) && (
            <Text style={styles.mapNote}>Some dates are missing venue coordinates and aren't shown on the map.</Text>
          )}
        </View>
      ) : (
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
      )}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg, paddingTop: 20, paddingHorizontal: 20 },
    centered: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
    header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 },
    title: { color: colors.text, fontSize: 26, fontFamily: fonts.displayBlack, letterSpacing: -0.4 },
    subtitle: { color: colors.textDim, fontSize: 13, marginTop: 2, fontFamily: fonts.body },
    toggleButton: { backgroundColor: colors.surface2, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
    toggleButtonText: { color: colors.accent, fontSize: 13, fontFamily: fonts.bodySemiBold },
    disclaimer: { color: colors.textFaint, fontSize: 12, marginBottom: 16, fontStyle: 'italic', fontFamily: fonts.body },
    mapContainer: { flex: 1, borderRadius: 12, overflow: 'hidden' },
    map: { flex: 1, backgroundColor: colors.bg },
    mapNote: { color: colors.textFaint, fontSize: 11, fontStyle: 'italic', paddingVertical: 8, fontFamily: fonts.body },
    error: { color: colors.danger, fontSize: 13, marginBottom: 12, fontFamily: fonts.body },
    emptyContainer: { flexGrow: 1, justifyContent: 'center' },
    emptyText: { color: colors.textFaint, fontSize: 14, textAlign: 'center', fontFamily: fonts.body },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 14,
      padding: 16,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.08,
      shadowRadius: 10,
      elevation: 2,
    },
    dateLabel: { color: colors.textDim, fontSize: 12, fontFamily: fonts.bodySemiBold, textTransform: 'uppercase', letterSpacing: 0.4 },
    venueLabel: { color: colors.text, fontSize: 17, fontFamily: fonts.displayBold, marginTop: 4 },
    cityLabel: { color: colors.textFaint, fontSize: 13, marginTop: 2, fontFamily: fonts.body },
    connector: { alignItems: 'center', paddingVertical: 6 },
    connectorLine: { width: 1, height: 14, backgroundColor: colors.border },
    connectorText: { color: colors.textFaint, fontSize: 11, marginTop: 2, fontFamily: fonts.mono },
  });
}
