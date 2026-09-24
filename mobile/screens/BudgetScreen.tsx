/**
 * BudgetScreen — income/expense entries, a running total, and three ways
 * to break it down: by week, by category, and deposits-in-progress.
 *
 * Unlike every other feature so far, there's no "what does crew see"
 * question here: budget_items has no crew-visible policy at all (see
 * 0001_init.sql — "budget readable by managers only"), so a crew
 * account's identical query simply returns nothing. This screen is only
 * ever reachable by managers in the first place (TourDashboardScreen
 * hides the entry point for everyone else), but that's UI convenience on
 * top of the real guarantee, not the guarantee itself.
 *
 * Per-week/per-category aggregation is pure client-side .reduce() over
 * whatever RLS already returned — same style as the original screen's
 * income/expense/net totals, just grouped a few more ways. No new
 * server-side rollup needed for a dataset this size (a tour's budget is,
 * at most, a few hundred rows).
 *
 * Theme (Manrope/JetBrains Mono, navy accent) per the "Load-In" design
 * review — see lib/theme.tsx.
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
import { logAuditEvent } from '../lib/auditLog';
import { formatDateOnly, getWeekStart } from '../lib/dates';
import { newId } from '../lib/ids';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Budget'>;

type BudgetItem = {
  id: string;
  category: string;
  category_id: string | null;
  description: string | null;
  amount: number;
  entry_type: 'income' | 'expense';
  created_at: string;
  receipt_path: string | null;
  tour_date_id: string | null;
  deposit_status: 'pending' | 'paid' | 'refunded' | null;
  tour_date: { date: string } | null;
};

type Category = { id: string; name: string; color: string | null };

type ViewMode = 'all' | 'week' | 'category' | 'deposits';
const VIEW_MODES: { value: ViewMode; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'week', label: 'By Week' },
  { value: 'category', label: 'By Category' },
  { value: 'deposits', label: 'Deposits' },
];

function signedAmount(item: BudgetItem): number {
  return item.entry_type === 'income' ? Number(item.amount) : -Number(item.amount);
}

export function BudgetScreen({ route, navigation }: Props) {
  const { tourId, tourName } = route.params;
  const { session } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [items, setItems] = useState<BudgetItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [settlementsTotal, setSettlementsTotal] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('all');
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function load() {
    const [{ data, error }, { data: categoryRows, error: categoryError }] = await Promise.all([
      supabase
        .from('budget_items')
        .select('id, category, category_id, description, amount, entry_type, created_at, receipt_path, tour_date_id, deposit_status, tour_date:tour_dates(date)')
        .eq('tour_id', tourId)
        .order('created_at', { ascending: false }),
      supabase.from('budget_categories').select('id, name, color').eq('tour_id', tourId).order('name', { ascending: true }),
    ]);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    if (categoryError) setErrorMessage(categoryError.message);
    setItems((data ?? []) as unknown as BudgetItem[]);
    setCategories(categoryRows ?? []);

    // settlements has no direct tour_id column — it's per tour_date, so
    // resolving "this tour's settlements" is a two-step lookup, same
    // pattern GuestListScreen already uses for tour_date-scoped data.
    const { data: dateRows, error: dateError } = await supabase.from('tour_dates').select('id').eq('tour_id', tourId);
    if (dateError) {
      setSettlementsTotal(null);
      return;
    }
    const dateIds = (dateRows ?? []).map((d) => d.id);
    if (dateIds.length === 0) {
      setSettlementsTotal(0);
      return;
    }
    const { data: settlementRows, error: settlementError } = await supabase
      .from('settlements')
      .select('net_to_artist')
      .in('tour_date_id', dateIds);
    if (settlementError) {
      setSettlementsTotal(null);
      return;
    }
    setSettlementsTotal((settlementRows ?? []).reduce((sum, s) => sum + Number(s.net_to_artist ?? 0), 0));
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

  async function handleAddCategory() {
    if (!newCategoryName.trim() || !session) return;
    const { error } = await supabase.from('budget_categories').insert({
      id: newId(),
      tour_id: tourId,
      name: newCategoryName.trim(),
      created_by: session.user.id,
    });
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    setNewCategoryName('');
    setShowAddCategory(false);
    await load();
  }

  function confirmDeleteCategory(category: Category) {
    Alert.alert('Delete this category?', `${category.name} — existing entries keep their free-text category label.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('budget_categories').delete().eq('id', category.id);
          if (error) setErrorMessage(error.message);
          else await load();
        },
      },
    ]);
  }

  function confirmDelete(item: BudgetItem) {
    Alert.alert('Delete entry?', `${item.category} — ${formatCurrency(item.amount)}`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('budget_items').delete().eq('id', item.id);
          if (error) {
            setErrorMessage(error.message);
            return;
          }
          if (session) {
            logAuditEvent({
              tourId,
              actorId: session.user.id,
              action: 'delete',
              resourceType: 'budget_item',
              resourceId: item.id,
              detail: { category: item.category, amount: item.amount },
            });
          }
          await load();
        },
      },
    ]);
  }

  function openReceipt(item: BudgetItem) {
    if (!item.receipt_path) return;
    navigation.navigate('ViewDocument', { bucket: 'tour-receipts', storagePath: item.receipt_path, title: `${item.category} receipt` });
  }

  const totals = useMemo(() => {
    const income = items.filter((i) => i.entry_type === 'income').reduce((sum, i) => sum + Number(i.amount), 0);
    const expense = items.filter((i) => i.entry_type === 'expense').reduce((sum, i) => sum + Number(i.amount), 0);
    return { income, expense, net: income - expense };
  }, [items]);

  // Grouped by the ISO week (Monday start) of each item's linked show
  // date; anything with no tour_date_id lands in "Unassigned." Sorted
  // chronologically with a running cumulative balance across weeks —
  // "how much is left" as of each week, not just that week's own net.
  const weekGroups = useMemo(() => {
    const buckets = new Map<string, BudgetItem[]>();
    for (const item of items) {
      const key = item.tour_date?.date ? getWeekStart(item.tour_date.date) : 'unassigned';
      (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(item);
    }
    const keys = Array.from(buckets.keys()).sort((a, b) => (a === 'unassigned' ? 1 : b === 'unassigned' ? -1 : a.localeCompare(b)));
    let running = 0;
    return keys.map((key) => {
      const rows = buckets.get(key)!;
      const net = rows.reduce((sum, i) => sum + signedAmount(i), 0);
      running += net;
      return { key, rows, net, running };
    });
  }, [items]);

  const categoryGroups = useMemo(() => {
    const buckets = new Map<string, { label: string; rows: BudgetItem[] }>();
    for (const item of items) {
      const key = item.category_id ?? `free:${item.category}`;
      const label = item.category;
      if (!buckets.has(key)) buckets.set(key, { label, rows: [] });
      buckets.get(key)!.rows.push(item);
    }
    return Array.from(buckets.entries())
      .map(([key, { label, rows }]) => ({ key, label, rows, net: rows.reduce((sum, i) => sum + signedAmount(i), 0) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [items]);

  const depositItems = useMemo(() => items.filter((i) => i.deposit_status != null), [items]);

  function formatCurrency(n: number) {
    return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
  }

  function renderItemRow(item: BudgetItem) {
    return (
      <Pressable
        key={item.id}
        style={styles.card}
        onPress={() => openReceipt(item)}
        onLongPress={() => confirmDelete(item)}
        disabled={!item.receipt_path}
      >
        <View style={styles.cardMain}>
          <Text style={styles.category}>{item.category}</Text>
          {item.description && <Text style={styles.description}>{item.description}</Text>}
          <View style={styles.badgeRow}>
            {item.tour_date?.date && <Text style={styles.badge}>{formatDateOnly(item.tour_date.date, { month: 'short', day: 'numeric' })}</Text>}
            {item.deposit_status && <Text style={[styles.badge, styles.depositBadge]}>{item.deposit_status.toUpperCase()}</Text>}
          </View>
          {item.receipt_path && <Text style={styles.receiptLink}>📎 Receipt</Text>}
        </View>
        <View style={styles.cardActions}>
          <Text style={[styles.amount, { color: item.entry_type === 'income' ? colors.success : colors.danger }]}>
            {item.entry_type === 'income' ? '+' : '−'}
            {formatCurrency(Math.abs(item.amount))}
          </Text>
          <Pressable style={styles.deleteButton} onPress={() => confirmDelete(item)}>
            <Text style={styles.deleteButtonText}>Delete</Text>
          </Pressable>
        </View>
      </Pressable>
    );
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
          <Text style={styles.title}>Budget</Text>
          <Text style={styles.subtitle}>{tourName}</Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable style={styles.secondaryButton} onPress={() => navigation.navigate('ImportBudget', { tourId })}>
            <Text style={styles.secondaryButtonText}>Import</Text>
          </Pressable>
          <Pressable style={styles.addButton} onPress={() => navigation.navigate('AddBudgetItem', { tourId })}>
            <Text style={styles.addButtonText}>+ Entry</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.summary}>
        <View style={styles.summaryItem}>
          <Text style={styles.summaryLabel}>Income</Text>
          <Text style={[styles.summaryValue, { color: colors.success }]}>{formatCurrency(totals.income)}</Text>
        </View>
        <View style={styles.summaryItem}>
          <Text style={styles.summaryLabel}>Expenses</Text>
          <Text style={[styles.summaryValue, { color: colors.danger }]}>{formatCurrency(totals.expense)}</Text>
        </View>
        <View style={styles.summaryItem}>
          <Text style={styles.summaryLabel}>Net</Text>
          <Text style={[styles.summaryValue, { color: totals.net >= 0 ? colors.success : colors.danger }]}>
            {formatCurrency(totals.net)}
          </Text>
        </View>
      </View>

      {settlementsTotal !== null && settlementsTotal !== 0 && (
        <View style={styles.settlementsCard}>
          <Text style={styles.settlementsLabel}>Settlements (separate from the manual entries below)</Text>
          <Text style={[styles.settlementsValue, { color: settlementsTotal >= 0 ? colors.success : colors.danger }]}>
            {formatCurrency(settlementsTotal)} net to artist
          </Text>
        </View>
      )}

      <View style={styles.filterRow}>
        {VIEW_MODES.map((m) => (
          <Pressable key={m.value} style={[styles.filterChip, viewMode === m.value && styles.filterChipActive]} onPress={() => setViewMode(m.value)}>
            <Text style={[styles.filterChipText, viewMode === m.value && styles.filterChipTextActive]}>{m.label}</Text>
          </Pressable>
        ))}
      </View>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.accent} />}
        contentContainerStyle={items.length === 0 && styles.emptyContainer}
      >
        {items.length === 0 ? (
          <Text style={styles.emptyText}>No entries yet.</Text>
        ) : viewMode === 'all' ? (
          items.map(renderItemRow)
        ) : viewMode === 'week' ? (
          weekGroups.map((group) => (
            <View key={group.key}>
              <View style={styles.groupHeader}>
                <Text style={styles.groupTitle}>
                  {group.key === 'unassigned' ? 'No show date linked' : `Week of ${formatDateOnly(group.key, { month: 'short', day: 'numeric' })}`}
                </Text>
                <View>
                  <Text style={[styles.groupNet, { color: group.net >= 0 ? colors.success : colors.danger }]}>{formatCurrency(group.net)}</Text>
                  <Text style={styles.groupRunning}>{formatCurrency(group.running)} running</Text>
                </View>
              </View>
              {group.rows.map(renderItemRow)}
            </View>
          ))
        ) : viewMode === 'category' ? (
          <>
            <View style={styles.categoryManageRow}>
              <Text style={styles.groupTitle}>Categories</Text>
              <Pressable onPress={() => setShowAddCategory((v) => !v)}>
                <Text style={styles.sectionAction}>{showAddCategory ? 'Cancel' : '+ New'}</Text>
              </Pressable>
            </View>
            {showAddCategory && (
              <View style={styles.addCategoryRow}>
                <TextInput
                  style={styles.addCategoryInput}
                  placeholder="Category name"
                  placeholderTextColor={colors.textFaint}
                  value={newCategoryName}
                  onChangeText={setNewCategoryName}
                  onSubmitEditing={handleAddCategory}
                />
                <Pressable style={styles.miniSaveButton} onPress={handleAddCategory} disabled={!newCategoryName.trim()}>
                  <Text style={styles.miniSaveButtonText}>Add</Text>
                </Pressable>
              </View>
            )}
            {categories.length > 0 && (
              <View style={styles.chipRow}>
                {categories.map((c) => (
                  <Pressable key={c.id} style={styles.categoryChip} onLongPress={() => confirmDeleteCategory(c)}>
                    <Text style={styles.categoryChipText}>{c.name}</Text>
                  </Pressable>
                ))}
              </View>
            )}
            {categoryGroups.map((group) => (
              <View key={group.key}>
                <View style={styles.groupHeader}>
                  <Text style={styles.groupTitle}>{group.label}</Text>
                  <Text style={[styles.groupNet, { color: group.net >= 0 ? colors.success : colors.danger }]}>{formatCurrency(group.net)}</Text>
                </View>
                {group.rows.map(renderItemRow)}
              </View>
            ))}
          </>
        ) : depositItems.length === 0 ? (
          <Text style={styles.emptyText}>No deposits tracked yet — mark an entry as a deposit when adding it.</Text>
        ) : (
          depositItems.map(renderItemRow)
        )}
        {items.length > 0 && viewMode === 'all' && <Text style={styles.hint}>Tap an entry with a receipt to view it. Tap Delete (or hold an entry) to remove it.</Text>}
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
    headerActions: { flexDirection: 'row', gap: 8 },
    addButton: { backgroundColor: colors.accent, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
    addButtonText: { color: colors.onAccent, fontSize: 13, fontFamily: fonts.bodySemiBold },
    secondaryButton: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
    secondaryButtonText: { color: colors.accent, fontSize: 13, fontFamily: fonts.bodySemiBold },
    summary: {
      flexDirection: 'row',
      backgroundColor: colors.surface,
      borderRadius: 14,
      padding: 14,
      marginBottom: 16,
    },
    summaryItem: { flex: 1, alignItems: 'center' },
    summaryLabel: { color: colors.textFaint, fontSize: 11, textTransform: 'uppercase', fontFamily: fonts.body },
    summaryValue: { fontSize: 16, fontFamily: fonts.displayBold, marginTop: 4 },
    settlementsCard: {
      backgroundColor: colors.surface2,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 12,
      marginBottom: 16,
    },
    settlementsLabel: { color: colors.textFaint, fontSize: 11, textTransform: 'uppercase', fontFamily: fonts.body },
    settlementsValue: { fontSize: 14, fontFamily: fonts.displayBold, marginTop: 4 },
    filterRow: { flexDirection: 'row', gap: 8, marginBottom: 14, flexWrap: 'wrap' },
    filterChip: { backgroundColor: colors.surface2, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7 },
    filterChipActive: { backgroundColor: colors.accent },
    filterChipText: { color: colors.textDim, fontSize: 12, fontFamily: fonts.bodySemiBold },
    filterChipTextActive: { color: colors.onAccent },
    error: { color: colors.danger, fontSize: 13, marginBottom: 12, fontFamily: fonts.body },
    emptyContainer: { flexGrow: 1, justifyContent: 'center' },
    emptyText: { color: colors.textFaint, fontSize: 14, textAlign: 'center', fontFamily: fonts.body },
    groupHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 14, marginBottom: 8 },
    groupTitle: { color: colors.textDim, fontSize: 12, fontFamily: fonts.bodySemiBold, textTransform: 'uppercase', letterSpacing: 0.5 },
    groupNet: { fontSize: 14, fontFamily: fonts.displaySemiBold, textAlign: 'right' },
    groupRunning: { color: colors.textFaint, fontSize: 10, fontFamily: fonts.mono, textAlign: 'right', marginTop: 1 },
    categoryManageRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
    sectionAction: { color: colors.accent, fontSize: 13, fontFamily: fonts.bodySemiBold },
    addCategoryRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
    addCategoryInput: {
      flex: 1,
      backgroundColor: colors.surface,
      color: colors.text,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 9,
      fontSize: 13,
      fontFamily: fonts.body,
      borderWidth: 1,
      borderColor: colors.border,
    },
    miniSaveButton: { backgroundColor: colors.accent, borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center' },
    miniSaveButtonText: { color: colors.onAccent, fontSize: 13, fontFamily: fonts.bodySemiBold },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
    categoryChip: { backgroundColor: colors.surface2, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
    categoryChipText: { color: colors.textDim, fontSize: 11, fontFamily: fonts.bodySemiBold },
    card: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: 12,
      padding: 14,
      marginBottom: 8,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.08,
      shadowRadius: 10,
      elevation: 2,
    },
    cardMain: { flex: 1, paddingRight: 8 },
    category: { color: colors.text, fontSize: 14, fontFamily: fonts.displaySemiBold },
    description: { color: colors.textDim, fontSize: 12, marginTop: 2, fontFamily: fonts.body },
    badgeRow: { flexDirection: 'row', gap: 6, marginTop: 4 },
    badge: {
      color: colors.textFaint,
      fontSize: 10,
      fontFamily: fonts.mono,
      backgroundColor: colors.surface2,
      borderRadius: 6,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    depositBadge: { color: colors.warn, backgroundColor: colors.warnSoft },
    receiptLink: { color: colors.accent, fontSize: 12, marginTop: 4, fontFamily: fonts.bodySemiBold },
    cardActions: { alignItems: 'flex-end', gap: 6 },
    amount: { fontSize: 15, fontFamily: fonts.monoMedium },
    deleteButton: { backgroundColor: colors.dangerSoft, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
    deleteButtonText: { color: colors.danger, fontSize: 11, fontFamily: fonts.bodySemiBold },
    hint: { color: colors.textFaint, fontSize: 12, textAlign: 'center', marginTop: 8, fontFamily: fonts.body },
  });
}
