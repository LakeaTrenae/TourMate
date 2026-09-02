/**
 * VenuesScreen — an organization's reusable venue database. Venues are
 * org-scoped, not tour-scoped (see venues.organization_id in 0001_init.sql)
 * — a venue you play this year is worth keeping around for next year's
 * routing, which is why this lives off Settings' org list rather than any
 * single tour.
 *
 * Grid layout + theme (Fraunces/Manrope/JetBrains Mono, navy accent) per
 * the "Load-In" design review — see lib/theme.tsx.
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
  TextInput,
  View,
} from 'react-native';

import { supabase } from '../lib/supabase';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
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

function chunkPairs<T>(items: T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return rows;
}

export function VenuesScreen({ route, navigation }: Props) {
  const { organizationId, organizationName } = route.params;
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

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
  const rows = useMemo(() => chunkPairs(filtered), [filtered]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  function renderVenueCard(venue: Venue) {
    return (
      <Pressable
        key={venue.id}
        style={styles.card}
        onPress={() => navigation.navigate('AddVenue', { organizationId, venueId: venue.id })}
        onLongPress={() => confirmDelete(venue)}
      >
        <View style={styles.mark} />
        <Text style={styles.venueName}>{venue.name}</Text>
        <View style={styles.venueMetaRow}>
          <Text style={styles.venueMeta} numberOfLines={1}>
            {[venue.city, venue.state].filter(Boolean).join(', ') || 'No city set'}
          </Text>
          {venue.capacity && <Text style={styles.venueCapacity}>{venue.capacity.toLocaleString()} cap</Text>}
        </View>
        {!venue.latitude && <Text style={styles.notGeocoded}>Not geocoded</Text>}
        <Pressable style={styles.deleteButton} onPress={() => confirmDelete(venue)}>
          <Text style={styles.deleteButtonText}>Delete</Text>
        </Pressable>
      </Pressable>
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
        placeholderTextColor={colors.textFaint}
        value={search}
        onChangeText={setSearch}
      />

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.accent} />}
        contentContainerStyle={filtered.length === 0 && styles.emptyContainer}
      >
        {filtered.length === 0 ? (
          <Text style={styles.emptyText}>{search ? 'No venues match that search.' : 'No venues yet.'}</Text>
        ) : (
          rows.map((row, i) => (
            <View key={row.map((v) => v.id).join('-') || i} style={styles.row}>
              {row.map(renderVenueCard)}
              {row.length === 1 && <View style={styles.rowSpacer} />}
            </View>
          ))
        )}
        {filtered.length > 0 && <Text style={styles.hint}>Tap to edit · tap Delete (or hold) to remove.</Text>}
      </ScrollView>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg, paddingTop: 20, paddingHorizontal: 20 },
    centered: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
    header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 },
    title: { color: colors.text, fontSize: 26, fontFamily: fonts.displayBlack, letterSpacing: -0.4 },
    subtitle: { color: colors.textDim, fontSize: 13, marginTop: 2, fontFamily: fonts.body },
    addButton: { backgroundColor: colors.accent, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
    addButtonText: { color: colors.onAccent, fontSize: 13, fontFamily: fonts.bodySemiBold },
    search: {
      backgroundColor: colors.surface,
      color: colors.text,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
      fontSize: 14,
      fontFamily: fonts.body,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: colors.border,
    },
    error: { color: colors.danger, fontSize: 13, marginBottom: 12, fontFamily: fonts.body },
    emptyContainer: { flexGrow: 1, justifyContent: 'center' },
    emptyText: { color: colors.textFaint, fontSize: 14, textAlign: 'center', fontFamily: fonts.body },
    row: { flexDirection: 'row', gap: 10, marginBottom: 10 },
    rowSpacer: { flex: 1 },
    card: {
      flex: 1,
      backgroundColor: colors.surface,
      borderRadius: 14,
      padding: 14,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.08,
      shadowRadius: 10,
      elevation: 2,
    },
    mark: {
      height: 40,
      borderRadius: 8,
      marginBottom: 10,
      backgroundColor: colors.accent2,
    },
    venueName: { color: colors.text, fontSize: 15, fontFamily: fonts.displaySemiBold, marginBottom: 6 },
    venueMetaRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 6 },
    venueMeta: { color: colors.textDim, fontSize: 11, fontFamily: fonts.mono, flexShrink: 1 },
    venueCapacity: { color: colors.textDim, fontSize: 11, fontFamily: fonts.mono },
    notGeocoded: { color: colors.warn, fontSize: 10, marginTop: 6, fontFamily: fonts.body },
    deleteButton: {
      alignSelf: 'flex-start',
      backgroundColor: colors.dangerSoft,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 4,
      marginTop: 10,
    },
    deleteButtonText: { color: colors.danger, fontSize: 11, fontFamily: fonts.bodySemiBold },
    hint: { color: colors.textFaint, fontSize: 12, textAlign: 'center', marginTop: 8, fontFamily: fonts.body },
  });
}
