/**
 * DocumentsScreen — tour documents (contracts, riders, advances), backed
 * by real files in Supabase Storage, not just metadata.
 *
 * The list query only returns rows RLS allows ("documents readable per
 * visibility" in 0001_init.sql) — crew never even sees a managers_only
 * document's title, let alone its file. Opening a file gets a short-lived
 * signed URL (the bucket is private) rather than a permanent public link,
 * so a URL that leaks or gets cached somewhere doesn't stay valid forever.
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
  View,
} from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
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

function chunkPairs<T>(items: T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return rows;
}

export function DocumentsScreen({ route, navigation }: Props) {
  const { tourId, tourName } = route.params;
  const { session } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [isManager, setIsManager] = useState(false);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [activeCategory, setActiveCategory] = useState<Category | null>(null);
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

  function openDocument(doc: Doc) {
    // ViewDocumentScreen fetches its own fresh signed URL on mount rather
    // than reusing one generated here — see that screen's header comment.
    navigation.navigate('ViewDocument', { bucket: 'tour-documents', storagePath: doc.storage_path, title: doc.title });
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
  const rows = useMemo(() => chunkPairs(filteredDocs), [filteredDocs]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  function renderDocCard(doc: Doc) {
    return (
      <Pressable
        key={doc.id}
        style={styles.card}
        onPress={() => openDocument(doc)}
        onLongPress={isManager ? () => confirmDelete(doc) : undefined}
      >
        <Text style={styles.eyebrow}>
          {CATEGORY_LABELS[doc.category].toUpperCase()}
          {doc.visibility === 'managers_only' ? ' · MANAGERS ONLY' : ''}
        </Text>
        <Text style={styles.docTitle} numberOfLines={2}>
          {doc.title}
        </Text>
        <Text style={styles.docMeta}>
          {new Date(doc.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
          {doc.artist ? ` · ${doc.artist.name}` : ''}
        </Text>
        <View style={styles.cardFooter}>
          {isManager && (
            <Pressable onPress={() => navigation.navigate('DocumentSharing', { documentId: doc.id, tourId, docTitle: doc.title })}>
              <Text style={styles.shareLink}>Share ›</Text>
            </Pressable>
          )}
          {isManager && (
            <Pressable style={styles.deleteButton} onPress={() => confirmDelete(doc)}>
              <Text style={styles.deleteButtonText}>Delete</Text>
            </Pressable>
          )}
        </View>
      </Pressable>
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
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.accent} />}
        contentContainerStyle={filteredDocs.length === 0 && styles.emptyContainer}
      >
        {filteredDocs.length === 0 ? (
          <Text style={styles.emptyText}>
            {isManager ? 'No documents yet.' : 'No documents shared with you yet.'}
          </Text>
        ) : (
          rows.map((row, i) => (
            <View key={row.map((d) => d.id).join('-') || i} style={styles.row}>
              {row.map(renderDocCard)}
              {row.length === 1 && <View style={styles.rowSpacer} />}
            </View>
          ))
        )}
        {isManager && filteredDocs.length > 0 && <Text style={styles.hint}>Tap Delete (or hold a document) to remove it.</Text>}
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
    chipRow: { flexGrow: 0, marginBottom: 12 },
    chipRowContent: { gap: 8, paddingRight: 8 },
    chip: { backgroundColor: colors.surface2, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 7 },
    chipActive: { backgroundColor: colors.accent },
    chipText: { color: colors.textDim, fontSize: 12, fontFamily: fonts.bodySemiBold },
    chipTextActive: { color: colors.onAccent },
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
    eyebrow: { color: colors.textDim, fontSize: 9, fontFamily: fonts.mono, letterSpacing: 0.4, marginBottom: 7 },
    docTitle: { color: colors.text, fontSize: 14.5, fontFamily: fonts.displaySemiBold, marginBottom: 7, lineHeight: 18 },
    docMeta: { color: colors.textDim, fontSize: 10.5, fontFamily: fonts.mono },
    cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 },
    shareLink: { color: colors.accent, fontSize: 12, fontFamily: fonts.bodySemiBold },
    deleteButton: { backgroundColor: colors.dangerSoft, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
    deleteButtonText: { color: colors.danger, fontSize: 11, fontFamily: fonts.bodySemiBold },
    hint: { color: colors.textFaint, fontSize: 12, textAlign: 'center', marginTop: 8, fontFamily: fonts.body },
  });
}
