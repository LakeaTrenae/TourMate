/**
 * ArtistsScreen — the acts on this tour's bill. Just names here — "who's
 * playing" is normal show info, visible to the whole tour ("artists
 * readable by tour members", 0027). The actually-private stuff
 * (management contacts, team roster, dressing room, tagged riders) lives
 * one tap in, on ArtistDetailScreen, gated to management + that artist's
 * own team.
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
import { useAuth } from '../lib/auth-context';
import { newId } from '../lib/ids';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Artists'>;

type Artist = { id: string; name: string };

const MANAGER_TIERS = new Set(['owner', 'admin', 'manager']);

export function ArtistsScreen({ route, navigation }: Props) {
  const { tourId, tourName } = route.params;
  const { session } = useAuth();

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
        <Text style={styles.title}>Artists</Text>
        <Text style={styles.subtitle}>{tourName}</Text>
      </View>

      {canManage && (
        <View style={styles.addRow}>
          <TextInput
            style={styles.addInput}
            placeholder="Artist or act name"
            placeholderTextColor="#6b6b76"
            value={newName}
            onChangeText={setNewName}
          />
          <Pressable style={styles.addButton} onPress={handleAdd} disabled={adding || !newName.trim()}>
            {adding ? <ActivityIndicator color="#0b0b0f" /> : <Text style={styles.addButtonText}>Add</Text>}
          </Pressable>
        </View>
      )}

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#fff" />}
        contentContainerStyle={artists.length === 0 && styles.emptyContainer}
      >
        {artists.length === 0 ? (
          <Text style={styles.emptyText}>No artists added yet.</Text>
        ) : (
          artists.map((artist) => (
            <Pressable
              key={artist.id}
              style={styles.card}
              onPress={() => navigation.navigate('ArtistDetail', { artistId: artist.id, tourId, artistName: artist.name })}
              onLongPress={canManage ? () => confirmDelete(artist) : undefined}
            >
              <Text style={styles.artistName}>{artist.name}</Text>
              <Text style={styles.openArrow}>›</Text>
            </Pressable>
          ))
        )}
        {canManage && artists.length > 0 && <Text style={styles.hint}>Hold an artist to remove them.</Text>}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b0f', paddingTop: 20, paddingHorizontal: 20 },
  centered: { flex: 1, backgroundColor: '#0b0b0f', alignItems: 'center', justifyContent: 'center' },
  header: { marginBottom: 16 },
  title: { color: '#fff', fontSize: 24, fontWeight: '700' },
  subtitle: { color: '#6b6b76', fontSize: 13, marginTop: 2 },
  addRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  addInput: {
    flex: 1,
    backgroundColor: '#1a1a20',
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  addButton: { backgroundColor: '#fff', borderRadius: 10, paddingHorizontal: 20, justifyContent: 'center' },
  addButtonText: { color: '#0b0b0f', fontSize: 14, fontWeight: '600' },
  error: { color: '#ff6b6b', fontSize: 13, marginBottom: 12 },
  emptyContainer: { flexGrow: 1, justifyContent: 'center' },
  emptyText: { color: '#6b6b76', fontSize: 14, textAlign: 'center' },
  card: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#1a1a20',
    borderRadius: 12,
    padding: 16,
    marginBottom: 10,
  },
  artistName: { color: '#fff', fontSize: 16, fontWeight: '600' },
  openArrow: { color: '#6b6b76', fontSize: 18 },
  hint: { color: '#6b6b76', fontSize: 12, textAlign: 'center', marginTop: 8 },
});
