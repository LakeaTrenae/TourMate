/**
 * ArtistsScreen — the acts on this tour's bill. Just names here — "who's
 * playing" is normal show info, visible to the whole tour ("artists
 * readable by tour members", 0027). The actually-private stuff
 * (management contacts, team roster, dressing room, tagged riders) lives
 * one tap in, on ArtistDetailScreen, gated to management + that artist's
 * own team.
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
import { useAuth } from '../lib/auth-context';
import { newId } from '../lib/ids';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Artists'>;

type Artist = { id: string; name: string };

const MANAGER_TIERS = new Set(['owner', 'admin', 'manager']);

function chunkPairs<T>(items: T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return rows;
}

export function ArtistsScreen({ route, navigation }: Props) {
  const { tourId, tourName } = route.params;
  const { session } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [artists, setArtists] = useState<Artist[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function load() {
    if (session) {
      const [{ data: roleData }, { data: deptData }] = await Promise.all([
        supabase.rpc('effective_tour_role', { p_tour_id: tourId, p_user_id: session.user.id }),
        supabase.rpc('department_on_tour', { p_tour_id: tourId, p_user_id: session.user.id }),
      ]);
      setCanManage((roleData ? MANAGER_TIERS.has(roleData) : false) || deptData === 'production');
    }

    const { data, error } = await supabase.from('artists').select('id, name').eq('tour_id', tourId).order('name', { ascending: true });
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    setArtists(data ?? []);
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

  async function handleAdd() {
    if (!session || !newName.trim()) return;
    setErrorMessage(null);
    setAdding(true);
    const { error } = await supabase
      .from('artists')
      .insert({ id: newId(), tour_id: tourId, name: newName.trim(), created_by: session.user.id });
    setAdding(false);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    setNewName('');
    await load();
  }

  function confirmDelete(artist: Artist) {
    Alert.alert(
      'Remove this artist?',
      `${artist.name} — this also removes their dressing room assignments, team roster, and any documents tagged to them (the documents themselves stay, just untagged).`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            const { error } = await supabase.from('artists').delete().eq('id', artist.id);
            if (error) setErrorMessage(error.message);
            else await load();
          },
        },
      ]
    );
  }

  const rows = useMemo(() => chunkPairs(artists), [artists]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  function renderArtistCard(artist: Artist) {
    return (
      <Pressable
        key={artist.id}
        style={styles.card}
        onPress={() => navigation.navigate('ArtistDetail', { artistId: artist.id, tourId, artistName: artist.name })}
        onLongPress={canManage ? () => confirmDelete(artist) : undefined}
      >
        <Text style={styles.artistName}>{artist.name}</Text>
        {canManage && (
          <Pressable style={styles.deleteButton} onPress={() => confirmDelete(artist)}>
            <Text style={styles.deleteButtonText}>Delete</Text>
          </Pressable>
        )}
      </Pressable>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Artists</Text>
        <Text style={styles.subtitle}>{tourName}</Text>
      </View>

      {canManage && (
        <View style={styles.addRow}>
          <TextInput
            style={styles.addInput}
            placeholder="Artist or act name"
            placeholderTextColor={colors.textFaint}
            value={newName}
            onChangeText={setNewName}
          />
          <Pressable style={styles.addButton} onPress={handleAdd} disabled={adding || !newName.trim()}>
            {adding ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.addButtonText}>Add</Text>}
          </Pressable>
        </View>
      )}

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.accent} />}
        contentContainerStyle={artists.length === 0 && styles.emptyContainer}
      >
        {artists.length === 0 ? (
          <Text style={styles.emptyText}>No artists added yet.</Text>
        ) : (
          rows.map((row, i) => (
            <View key={row.map((a) => a.id).join('-') || i} style={styles.row}>
              {row.map(renderArtistCard)}
              {row.length === 1 && <View style={styles.rowSpacer} />}
            </View>
          ))
        )}
        {canManage && artists.length > 0 && <Text style={styles.hint}>Tap Delete (or hold an artist) to remove them.</Text>}
      </ScrollView>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg, paddingTop: 20, paddingHorizontal: 20 },
    centered: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
    header: { marginBottom: 16 },
    title: { color: colors.text, fontSize: 26, fontFamily: fonts.displayBlack, letterSpacing: -0.4 },
    subtitle: { color: colors.textDim, fontSize: 13, marginTop: 2, fontFamily: fonts.body },
    addRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
    addInput: {
      flex: 1,
      backgroundColor: colors.surface,
      color: colors.text,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 15,
      fontFamily: fonts.body,
      borderWidth: 1,
      borderColor: colors.border,
    },
    addButton: { backgroundColor: colors.accent, borderRadius: 10, paddingHorizontal: 20, justifyContent: 'center' },
    addButtonText: { color: colors.onAccent, fontSize: 14, fontFamily: fonts.bodySemiBold },
    error: { color: colors.danger, fontSize: 13, marginBottom: 12, fontFamily: fonts.body },
    emptyContainer: { flexGrow: 1, justifyContent: 'center' },
    emptyText: { color: colors.textFaint, fontSize: 14, textAlign: 'center', fontFamily: fonts.body },
    row: { flexDirection: 'row', gap: 10, marginBottom: 10 },
    rowSpacer: { flex: 1 },
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
    artistName: { color: colors.text, fontSize: 16, fontFamily: fonts.displaySemiBold, marginBottom: 8 },
    deleteButton: {
      alignSelf: 'flex-start',
      backgroundColor: colors.dangerSoft,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    deleteButtonText: { color: colors.danger, fontSize: 11, fontFamily: fonts.bodySemiBold },
    hint: { color: colors.textFaint, fontSize: 12, textAlign: 'center', marginTop: 8, fontFamily: fonts.body },
  });
}
