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
import { createElement, useCallback, useMemo, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
// react-native-webview has no real web implementation — importing it
// unconditionally crashes the whole app on web ("React Native WebView
// does not support this platform"), and since React has no default error
// boundary here, that crash blanks the ENTIRE app, not just this screen,
// the moment anyone opens Route on web. A plain `require()` gated by
// Platform.OS (not a static `import`) is what actually keeps that module
// from being evaluated at all on web — a static import gets bundled and
// evaluated regardless of any runtime Platform check around its usage.
// On web, a bare DOM <iframe srcDoc={...}> is the direct equivalent of
// WebView's `source={{ html }}` — same self-contained-HTML use case.
const WebView = Platform.OS === 'web' ? null : (require('react-native-webview').WebView as typeof import('react-native-webview').WebView);

import { supabase } from '../lib/supabase';
import { formatDateOnly } from '../lib/dates';
import { haversineDistanceMiles } from '../lib/geo';
import { buildRouteMapHtml } from '../lib/routeMapHtml';
import { getInvokeErrorMessage } from '../lib/functionError';
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

type RealSegment = { distanceMiles: number; durationMinutes: number };

function segmentKey(fromId: string, toId: string) {
  return `${fromId}_${toId}`;
}

export function RouteScreen({ route, navigation }: Props) {
  const { tourId, tourName } = route.params;
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [stops, setStops] = useState<Stop[]>([]);
  const [realSegments, setRealSegments] = useState<Record<string, RealSegment>>({});
  const [loading, setLoading] = useState(true);
  const [computingRoutes, setComputingRoutes] = useState(false);
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

    const loadedStops = ((data ?? []) as unknown as { id: string; date: string; venue: { name: string; city: string | null; latitude: number | null; longitude: number | null } | null }[]).map(
      (row) => ({
        id: row.id,
        date: row.date,
        venueName: row.venue?.name ?? null,
        city: row.venue?.city ?? null,
        latitude: row.venue?.latitude ?? null,
        longitude: row.venue?.longitude ?? null,
      })
    );
    setStops(loadedStops);

    // Real driving segments already computed (route-directions writes
    // these; this is a free, cached read — the edge function is only
    // invoked on demand via "Calculate Driving Routes" below, since a
    // Google Routes API call costs money per pair).
    const dateIds = loadedStops.map((s) => s.id);
    if (dateIds.length > 0) {
      const { data: cached } = await supabase
        .from('route_segments')
        .select('from_tour_date_id, to_tour_date_id, distance_miles, duration_minutes')
        .in('from_tour_date_id', dateIds);
      const map: Record<string, RealSegment> = {};
      for (const row of cached ?? []) {
        map[segmentKey(row.from_tour_date_id, row.to_tour_date_id)] = {
          distanceMiles: row.distance_miles,
          durationMinutes: row.duration_minutes,
        };
      }
      setRealSegments(map);
    }
  }

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load().finally(() => setLoading(false));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tourId])
  );

  async function handleComputeRoutes() {
    setErrorMessage(null);
    setComputingRoutes(true);
    const { data, error } = await supabase.functions.invoke('route-directions', { body: { tourId } });
    setComputingRoutes(false);
    if (error || data?.error) {
      setErrorMessage(await getInvokeErrorMessage(error, data, 'Failed to calculate driving routes.'));
      return;
    }
    const map: Record<string, RealSegment> = { ...realSegments };
    for (const seg of data?.segments ?? []) {
      map[segmentKey(seg.from_tour_date_id, seg.to_tour_date_id)] = {
        distanceMiles: seg.distance_miles,
        durationMinutes: seg.duration_minutes,
      };
    }
    setRealSegments(map);
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
          <Text style={styles.title}>Route</Text>
          <Text style={styles.subtitle}>{tourName}</Text>
        </View>
        <View style={styles.headerActions}>
          {stops.length > 1 && (
            <Pressable style={styles.toggleButton} onPress={handleComputeRoutes} disabled={computingRoutes}>
              {computingRoutes ? (
                <ActivityIndicator color={colors.accent} size="small" />
              ) : (
                <Text style={styles.toggleButtonText}>Calculate Driving Routes</Text>
              )}
            </Pressable>
          )}
          {stops.length > 0 && (
            <Pressable style={styles.toggleButton} onPress={() => setShowMap((v) => !v)}>
              <Text style={styles.toggleButtonText}>{showMap ? 'List View' : 'Map View'}</Text>
            </Pressable>
          )}
        </View>
      </View>
      <Text style={styles.disclaimer}>
        {Object.keys(realSegments).length > 0
          ? 'Real driving distance/time where calculated — straight-line estimate otherwise.'
          : 'Estimated straight-line distance between shows — tap "Calculate Driving Routes" for real driving times.'}
      </Text>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      {showMap && stops.length > 0 ? (
        <View style={styles.mapContainer}>
          {Platform.OS === 'web'
            ? createElement('iframe', {
                srcDoc: buildRouteMapHtml(
                  stops
                    .filter((s): s is Stop & { latitude: number; longitude: number } => s.latitude != null && s.longitude != null)
                    .map((s) => ({
                      label: `${formatDateOnly(s.date, { month: 'short', day: 'numeric' })} — ${s.venueName ?? 'No venue set'}`,
                      latitude: s.latitude,
                      longitude: s.longitude,
                    }))
                ),
                style: { flex: 1, border: 'none' },
              })
            : WebView && (
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
              )}
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
            if (prev) {
              const real = realSegments[segmentKey(prev.id, stop.id)];
              if (real) {
                const hours = Math.floor(real.durationMinutes / 60);
                const mins = real.durationMinutes % 60;
                const durationLabel = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
                distanceLabel = `${real.distanceMiles.toLocaleString()} mi driving · ${durationLabel}`;
              } else if (prev.latitude != null && prev.longitude != null && stop.latitude != null && stop.longitude != null) {
                const miles = haversineDistanceMiles(prev.latitude, prev.longitude, stop.latitude, stop.longitude);
                distanceLabel = `${Math.round(miles).toLocaleString()} mi from previous (estimate)`;
              }
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
    headerActions: { flexDirection: 'row', gap: 8 },
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
