/**
 * ChecklistsScreen — list of this tour's checklists (venue walkthrough,
 * hospitality & rider notes, or anything else a department wants to
 * track as checkable items + a running notes field). Generic on purpose:
 * one feature backs every checklist instead of a separate screen per use
 * case (see 0021_security_hospitality_checklists.sql for the schema/RLS
 * this mirrors from schedule_items).
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
import { formatDepartment } from '../lib/format';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Checklists'>;

type Checklist = {
  id: string;
  title: string;
  department: string;
  visible_to_all: boolean;
  item_count: number;
  checked_count: number;
};

const MANAGER_TIERS = new Set(['owner', 'admin', 'manager']);

function chunkPairs<T>(items: T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return rows;
}

export function ChecklistsScreen({ route, navigation }: Props) {
  const { tourId, tourName } = route.params;
  const { session } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [isManager, setIsManager] = useState(false);
  const [ownDepartment, setOwnDepartment] = useState<string | null>(null);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
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

    const { data: ownMembership } = await supabase
      .from('tour_members')
      .select('department')
      .eq('tour_id', tourId)
      .eq('user_id', session.user.id)
      .maybeSingle();
    setOwnDepartment(ownMembership?.department ?? null);

    // RLS ("checklists readable per visibility rules") already returns
    // only what this user can see — no client-side filtering needed.
    const { data: checklistRows, error: checklistError } = await supabase
      .from('checklists')
      .select('id, title, department, visible_to_all')
      .eq('tour_id', tourId)
      .order('created_at', { ascending: false });
    if (checklistError) {
      setErrorMessage(checklistError.message);
      return;
    }

    const ids = (checklistRows ?? []).map((c) => c.id);
    let counts: Record<string, { total: number; checked: number }> = {};
    if (ids.length > 0) {
      const { data: itemRows, error: itemError } = await supabase
        .from('checklist_items')
        .select('checklist_id, is_checked')
        .in('checklist_id', ids);
      if (itemError) {
        setErrorMessage(itemError.message);
        return;
      }
      counts = {};
      for (const item of itemRows ?? []) {
        const bucket = (counts[item.checklist_id] ??= { total: 0, checked: 0 });
        bucket.total += 1;
        if (item.is_checked) bucket.checked += 1;
      }
    }

    setChecklists(
      (checklistRows ?? []).map((c) => ({
        ...c,
        item_count: counts[c.id]?.total ?? 0,
        checked_count: counts[c.id]?.checked ?? 0,
      }))
    );
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

  // Client-side approximation of can_edit_checklist, for deciding whether
  // to show the delete hint at all — RLS is the actual enforcement, this
  // just avoids offering an action that would only fail.
  function canEdit(checklist: Checklist) {
    return isManager || ownDepartment === checklist.department;
  }

  function confirmDelete(checklist: Checklist) {
    Alert.alert('Delete this checklist?', checklist.title, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('checklists').delete().eq('id', checklist.id);
          if (error) setErrorMessage(error.message);
          else await load();
        },
      },
    ]);
  }

  const rows = useMemo(() => chunkPairs(checklists), [checklists]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  function renderChecklistCard(c: Checklist) {
    const editable = canEdit(c);
    const hasItems = c.item_count > 0;
    const pct = hasItems ? c.checked_count / c.item_count : 0;
    const done = hasItems && c.checked_count === c.item_count;

    return (
      <Pressable
        key={c.id}
        style={styles.card}
        onPress={() => navigation.navigate('ChecklistDetail', { checklistId: c.id, tourId, title: c.title })}
        onLongPress={editable ? () => confirmDelete(c) : undefined}
      >
        <Text style={styles.eyebrow}>
          {formatDepartment(c.department).toUpperCase()}
          {!c.visible_to_all ? ' · DEPT ONLY' : ''}
        </Text>
        <Text style={styles.checklistTitle} numberOfLines={2}>
          {c.title}
        </Text>
        {hasItems ? (
          <>
            <Text style={styles.stat}>
              {c.checked_count}
              <Text style={styles.statTotal}>/{c.item_count}</Text>
            </Text>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.round(pct * 100)}%`, backgroundColor: done ? colors.success : colors.accent },
                ]}
              />
            </View>
          </>
        ) : (
          <Text style={styles.docMeta}>No items yet</Text>
        )}
        <View style={styles.cardFooter}>
          {editable && (
            <Pressable onPress={() => navigation.navigate('ChecklistSharing', { checklistId: c.id, tourId, checklistTitle: c.title })}>
              <Text style={styles.shareLink}>Share ›</Text>
            </Pressable>
          )}
          {editable && (
            <Pressable style={styles.deleteButton} onPress={() => confirmDelete(c)}>
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
          <Text style={styles.title}>Checklists</Text>
          <Text style={styles.subtitle}>{tourName}</Text>
        </View>
        <Pressable style={styles.addButton} onPress={() => navigation.navigate('AddChecklist', { tourId })}>
          <Text style={styles.addButtonText}>+ New</Text>
        </Pressable>
      </View>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.accent} />}
        contentContainerStyle={checklists.length === 0 && styles.emptyContainer}
      >
        {checklists.length === 0 ? (
          <Text style={styles.emptyText}>
            No checklists yet — venue walkthrough, hospitality & rider notes, load-in, whatever your team needs to
            track.
          </Text>
        ) : (
          rows.map((row, i) => (
            <View key={row.map((c) => c.id).join('-') || i} style={styles.row}>
              {row.map(renderChecklistCard)}
              {row.length === 1 && <View style={styles.rowSpacer} />}
            </View>
          ))
        )}
        {checklists.length > 0 && <Text style={styles.hint}>Tap Delete (or hold a checklist) to remove it.</Text>}
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
    checklistTitle: { color: colors.text, fontSize: 14.5, fontFamily: fonts.displaySemiBold, marginBottom: 8, lineHeight: 18 },
    stat: { color: colors.text, fontSize: 20, fontFamily: fonts.displayBold, marginBottom: 4 },
    statTotal: { fontSize: 13, color: colors.textDim, fontFamily: fonts.body },
    docMeta: { color: colors.textDim, fontSize: 10.5, fontFamily: fonts.mono },
    progressTrack: { height: 3, borderRadius: 2, backgroundColor: colors.surface2, overflow: 'hidden' },
    progressFill: { height: '100%', borderRadius: 2 },
    cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 },
    shareLink: { color: colors.accent, fontSize: 12, fontFamily: fonts.bodySemiBold },
    deleteButton: { backgroundColor: colors.dangerSoft, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
    deleteButtonText: { color: colors.danger, fontSize: 11, fontFamily: fonts.bodySemiBold },
    hint: { color: colors.textFaint, fontSize: 12, textAlign: 'center', marginTop: 8, fontFamily: fonts.body },
  });
}
