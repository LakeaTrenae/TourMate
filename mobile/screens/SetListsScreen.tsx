/**
 * SetListsScreen — every set list on this tour: a standing one per act,
 * or a night-specific override for one show. Mirrors ChecklistsScreen's
 * exact grid-card pattern (0021/0040's setlists table follows checklists'
 * schema almost verbatim).
 *
 * Theme (Manrope/JetBrains Mono, navy accent) per the "Load-In" design
 * review — see lib/theme.tsx.
 */
import { useCallback, useMemo, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { formatDepartment } from '../lib/format';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'SetLists'>;

type Setlist = {
  id: string;
  name: string;
  department: string;
  visible_to_all: boolean;
  artist: { name: string } | null;
  tour_date: { date: string } | null;
  item_count: number;
};

const MANAGER_TIERS = new Set(['owner', 'admin', 'manager']);

function chunkPairs<T>(items: T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return rows;
}

export function SetListsScreen({ route, navigation }: Props) {
  const { tourId, tourName } = route.params;
  const { session } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [isManager, setIsManager] = useState(false);
  const [ownDepartment, setOwnDepartment] = useState<string | null>(null);
  const [setlists, setSetlists] = useState<Setlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function load() {
    if (!session) return;

    const { data: roleData } = await supabase.rpc('effective_tour_role', { p_tour_id: tourId, p_user_id: session.user.id });
    setIsManager(roleData ? MANAGER_TIERS.has(roleData) : false);

    const { data: ownMembership } = await supabase
      .from('tour_members')
      .select('department')
      .eq('tour_id', tourId)
      .eq('user_id', session.user.id)
      .maybeSingle();
    setOwnDepartment(ownMembership?.department ?? null);

    const { data: setlistRows, error: setlistError } = await supabase
      .from('setlists')
      .select('id, name, department, visible_to_all, artist:artists(name), tour_date:tour_dates(date)')
      .eq('tour_id', tourId)
      .order('created_at', { ascending: false });
    if (setlistError) {
      setErrorMessage(setlistError.message);
      return;
    }

    const ids = (setlistRows ?? []).map((s) => s.id);
    let counts: Record<string, number> = {};
    if (ids.length > 0) {
      const { data: itemRows } = await supabase.from('setlist_items').select('setlist_id').in('setlist_id', ids);
      counts = {};
      for (const item of itemRows ?? []) counts[item.setlist_id] = (counts[item.setlist_id] ?? 0) + 1;
    }

    setSetlists((setlistRows ?? []).map((s) => ({ ...s, item_count: counts[s.id] ?? 0 })) as unknown as Setlist[]);
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

  function canEdit(s: Setlist) {
    return isManager || ownDepartment === s.department;
  }

  function confirmDelete(s: Setlist) {
    Alert.alert('Delete this set list?', s.name, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('setlists').delete().eq('id', s.id);
          if (error) setErrorMessage(error.message);
          else await load();
        },
      },
    ]);
  }

  const rows = useMemo(() => chunkPairs(setlists), [setlists]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  function renderCard(s: Setlist) {
    const editable = canEdit(s);
    return (
      <Pressable
        key={s.id}
        style={styles.card}
        onPress={() => navigation.navigate('SetListDetail', { setlistId: s.id, tourId, name: s.name })}
        onLongPress={editable ? () => confirmDelete(s) : undefined}
      >
        <Text style={styles.eyebrow}>
          {formatDepartment(s.department).toUpperCase()}
          {!s.visible_to_all ? ' · DEPT ONLY' : ''}
        </Text>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {s.name}
        </Text>
        {s.artist && <Text style={styles.cardMeta}>{s.artist.name}</Text>}
        <Text style={styles.cardMeta}>{s.tour_date ? s.tour_date.date : 'Standing set list'}</Text>
        <Text style={styles.stat}>
          {s.item_count} <Text style={styles.statLabel}>{s.item_count === 1 ? 'song' : 'songs'}</Text>
        </Text>
        <View style={styles.cardFooter}>
          {editable && (
            <Pressable onPress={() => navigation.navigate('SetListSharing', { setlistId: s.id, tourId, setlistName: s.name })}>
              <Text style={styles.shareLink}>Share ›</Text>
            </Pressable>
          )}
          {editable && (
            <Pressable style={styles.deleteButton} onPress={() => confirmDelete(s)}>
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
          <Text style={styles.title}>Set Lists</Text>
          <Text style={styles.subtitle}>{tourName}</Text>
        </View>
        <Pressable style={styles.addButton} onPress={() => navigation.navigate('AddSetList', { tourId })}>
          <Text style={styles.addButtonText}>+ New</Text>
        </Pressable>
      </View>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.accent} />}
        contentContainerStyle={setlists.length === 0 && styles.emptyContainer}
      >
        {setlists.length === 0 ? (
          <Text style={styles.emptyText}>No set lists yet — a standing one per act, or a night-specific override for one show.</Text>
        ) : (
          rows.map((row, i) => (
            <View key={row.map((s) => s.id).join('-') || i} style={styles.row}>
              {row.map(renderCard)}
              {row.length === 1 && <View style={styles.rowSpacer} />}
            </View>
          ))
        )}
        {setlists.length > 0 && <Text style={styles.hint}>Tap Delete (or hold a card) to remove it.</Text>}
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
    error: { color: colors.danger, fontSize: 13, marginBottom: 12, fontFamily: fonts.body },
    emptyContainer: { flexGrow: 1, justifyContent: 'center' },
    emptyText: { color: colors.textFaint, fontSize: 14, textAlign: 'center', paddingHorizontal: 10, fontFamily: fonts.body },
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
    cardTitle: { color: colors.text, fontSize: 14.5, fontFamily: fonts.displaySemiBold, marginBottom: 4, lineHeight: 18 },
    cardMeta: { color: colors.textDim, fontSize: 11, fontFamily: fonts.body, marginBottom: 2 },
    stat: { color: colors.text, fontSize: 18, fontFamily: fonts.displayBold, marginTop: 6 },
    statLabel: { fontSize: 12, color: colors.textDim, fontFamily: fonts.body },
    cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 },
    shareLink: { color: colors.accent, fontSize: 12, fontFamily: fonts.bodySemiBold },
    deleteButton: { backgroundColor: colors.dangerSoft, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
    deleteButtonText: { color: colors.danger, fontSize: 11, fontFamily: fonts.bodySemiBold },
    hint: { color: colors.textFaint, fontSize: 12, textAlign: 'center', marginTop: 8, fontFamily: fonts.body },
  });
}
