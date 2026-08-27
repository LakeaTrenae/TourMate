/**
 * DocumentsScreen — tour documents (contracts, riders, advances), backed
 * by real files in Supabase Storage, not just metadata.
 *
 * The list query only returns rows RLS allows ("documents readable per
 * visibility" in 0001_init.sql) — crew never even sees a managers_only
 * document's title, let alone its file. Opening a file gets a short-lived
 * signed URL (the bucket is private) rather than a permanent public link,
 * so a URL that leaks or gets cached somewhere doesn't stay valid forever.
 */
import { useCallback, useMemo, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import {
  ActivityIndicator,
  Alert,
  Linking,
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

type Props = NativeStackScreenProps<RootStackParamList, 'Documents'>;

type Category = 'general' | 'contract' | 'rider' | 'hospitality' | 'itinerary' | 'other';

type Doc = {
  id: string;
  title: string;
  storage_path: string;
  visibility: 'org' | 'managers_only';
  category: Category;
  created_at: string;
  artist: { name: string } | null;
};

const MANAGER_TIERS = new Set(['owner', 'admin', 'manager']);
const CATEGORY_LABELS: Record<Category, string> = {
  general: 'General',
  contract: 'Contract',
  rider: 'Rider',
  hospitality: 'Hospitality',
  itinerary: 'Itinerary',
  other: 'Other',
};
const CATEGORY_ORDER: Category[] = ['general', 'contract', 'rider', 'hospitality', 'itinerary', 'other'];

export function DocumentsScreen({ route, navigation }: Props) {
  const { tourId, tourName } = route.params;
  const { session } = useAuth();

  const [isManager, setIsManager] = useState(false);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [activeCategory, setActiveCategory] = useState<Category | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
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

    const { data, error } = await supabase
      .from('documents')
      .select('id, title, storage_path, visibility, category, created_at, artist:artists(name)')
      .eq('tour_id', tourId)
      .order('created_at', { ascending: false });
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    setDocs((data ?? []) as unknown as Doc[]);
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

  async function openDocument(doc: Doc) {
    setOpeningId(doc.id);
    setErrorMessage(null);
    // Signed URL expires in 5 minutes — long enough to open the file,
    // short enough that it's useless if it ends up somewhere it
    // shouldn't (a screenshot, a forwarded message, browser history).
    const { data, error } = await supabase.storage
      .from('tour-documents')
      .createSignedUrl(doc.storage_path, 60 * 5);
    setOpeningId(null);

    if (error || !data) {
      setErrorMessage(error?.message ?? 'Failed to open document.');
      return;
    }
    Linking.openURL(data.signedUrl);
  }

  function confirmDelete(doc: Doc) {
    Alert.alert('Delete this document?', doc.title, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          // Delete the DB row first — that's what actually controls
          // whether anyone can still see this document. The storage
          // object is cleaned up afterward on a best-effort basis: if
          // that second call fails, the file is just an orphaned blob
          // nobody can reach anymore (RLS still gates it, and it's no
          // longer linked from any row), not a broken link shown to a
          // user like the reverse ordering would risk.
          const { error } = await supabase.from('documents').delete().eq('id', doc.id);
          if (error) {
            setErrorMessage(error.message);
            return;
          }
          const { error: storageError } = await supabase.storage.from('tour-documents').remove([doc.storage_path]);
          if (storageError) {
            console.warn('Document row deleted but storage cleanup failed:', storageError.message);
          }
          await load();
        },
      },
    ]);
  }

  const presentCategories = useMemo(() => {
    const present = new Set(docs.map((d) => d.category));
    return CATEGORY_ORDER.filter((c) => present.has(c));
  }, [docs]);

  const filteredDocs = useMemo(
    () => (activeCategory ? docs.filter((d) => d.category === activeCategory) : docs),
    [docs, activeCategory]
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
        <View>
          <Text style={styles.title}>Documents</Text>
          <Text style={styles.subtitle}>{tourName}</Text>
        </View>
        {isManager && (
          <Pressable style={styles.addButton} onPress={() => navigation.navigate('AddDocument', { tourId })}>
            <Text style={styles.addButtonText}>+ Upload</Text>
          </Pressable>
        )}
      </View>

      {(presentCategories.length > 1 || activeCategory) && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow} contentContainerStyle={styles.chipRowContent}>
          <Pressable style={[styles.chip, activeCategory === null && styles.chipActive]} onPress={() => setActiveCategory(null)}>
            <Text style={[styles.chipText, activeCategory === null && styles.chipTextActive]}>All</Text>
          </Pressable>
          {presentCategories.map((c) => (
            <Pressable key={c} style={[styles.chip, activeCategory === c && styles.chipActive]} onPress={() => setActiveCategory(c)}>
              <Text style={[styles.chipText, activeCategory === c && styles.chipTextActive]}>{CATEGORY_LABELS[c]}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#fff" />}
        contentContainerStyle={filteredDocs.length === 0 && styles.emptyContainer}
      >
        {filteredDocs.length === 0 ? (
          <Text style={styles.emptyText}>
            {isManager ? 'No documents yet.' : 'No documents shared with you yet.'}
          </Text>
        ) : (
          filteredDocs.map((doc) => (
            <Pressable
              key={doc.id}
              style={styles.card}
              onPress={() => openDocument(doc)}
              onLongPress={isManager ? () => confirmDelete(doc) : undefined}
              disabled={openingId === doc.id}
            >
              <View style={styles.docInfo}>
                <Text style={styles.docTitle}>{doc.title}</Text>
                <Text style={styles.docMeta}>
                  {CATEGORY_LABELS[doc.category]} ·{' '}
                  {new Date(doc.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                  {doc.visibility === 'managers_only' ? ' · Managers only' : ''}
                  {doc.artist ? ` · ${doc.artist.name}` : ''}
                </Text>
                {isManager && (
                  <Pressable
                    onPress={() => navigation.navigate('DocumentSharing', { documentId: doc.id, tourId, docTitle: doc.title })}
                  >
                    <Text style={styles.shareLink}>Share ›</Text>
                  </Pressable>
                )}
              </View>
              {openingId === doc.id ? <ActivityIndicator color="#fff" /> : <Text style={styles.openArrow}>›</Text>}
            </Pressable>
          ))
        )}
        {isManager && filteredDocs.length > 0 && <Text style={styles.hint}>Hold a document to delete it.</Text>}
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
  chipRow: { flexGrow: 0, marginBottom: 12 },
  chipRowContent: { gap: 8, paddingRight: 8 },
  chip: { backgroundColor: '#1a1a20', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 7 },
  chipActive: { backgroundColor: '#fff' },
  chipText: { color: '#9a9aa5', fontSize: 12, fontWeight: '600' },
  chipTextActive: { color: '#0b0b0f' },
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
  docTitle: { color: '#fff', fontSize: 15, fontWeight: '600' },
  docInfo: { flex: 1 },
  docMeta: { color: '#6b6b76', fontSize: 12, marginTop: 4 },
  shareLink: { color: '#7c9cff', fontSize: 12, fontWeight: '600', marginTop: 6 },
  openArrow: { color: '#6b6b76', fontSize: 18 },
  hint: { color: '#6b6b76', fontSize: 12, textAlign: 'center', marginTop: 8 },
});