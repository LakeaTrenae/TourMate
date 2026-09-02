/**
 * BudgetScreen — income/expense entries and a running total.
 *
 * Unlike every other feature so far, there's no "what does crew see"
 * question here: budget_items has no crew-visible policy at all (see
 * 0001_init.sql — "budget readable by managers only"), so a crew
 * account's identical query simply returns nothing. This screen is only
 * ever reachable by managers in the first place (TourDashboardScreen
 * hides the entry point for everyone else), but that's UI convenience on
 * top of the real guarantee, not the guarantee itself.
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
  View,
} from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { logAuditEvent } from '../lib/auditLog';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Budget'>;

type BudgetItem = {
  id: string;
  category: string;
  description: string | null;
  amount: number;
  entry_type: 'income' | 'expense';
  created_at: string;
  receipt_path: string | null;
};

export function BudgetScreen({ route, navigation }: Props) {
  const { tourId, tourName } = route.params;
  const { session } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [items, setItems] = useState<BudgetItem[]>([]);
  const [settlementsTotal, setSettlementsTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function load() {
    const { data, error } = await supabase
      .from('budget_items')
      .select('id, category, description, amount, entry_type, created_at, receipt_path')
      .eq('tour_id', tourId)
      .order('created_at', { ascending: false });
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    setItems(data ?? []);

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

  function formatCurrency(n: number) {
    return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
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
        <Pressable style={styles.addButton} onPress={() => navigation.navigate('AddBudgetItem', { tourId })}>
          <Text style={styles.addButtonText}>+ Entry</Text>
        </Pressable>
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

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.accent} />}
        contentContainerStyle={items.length === 0 && styles.emptyContainer}
      >
        {items.length === 0 ? (
          <Text style={styles.emptyText}>No entries yet.</Text>
        ) : (
          items.map((item) => (
            <Pressable
              key={item.id}
              style={styles.card}
              onPress={() => openReceipt(item)}
              onLongPress={() => confirmDelete(item)}
              disabled={!item.receipt_path}
            >
              <View>
                <Text style={styles.category}>{item.category}</Text>
                {item.description && <Text style={styles.description}>{item.description}</Text>}
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
          ))
        )}
        {items.length > 0 && <Text style={styles.hint}>Tap an entry with a receipt to view it. Tap Delete (or hold an entry) to remove it.</Text>}
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
    error: { color: colors.danger, fontSize: 13, marginBottom: 12, fontFamily: fonts.body },
    emptyContainer: { flexGrow: 1, justifyContent: 'center' },
    emptyText: { color: colors.textFaint, fontSize: 14, textAlign: 'center', fontFamily: fonts.body },
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
    category: { color: colors.text, fontSize: 14, fontFamily: fonts.displaySemiBold },
    description: { color: colors.textDim, fontSize: 12, marginTop: 2, fontFamily: fonts.body },
    receiptLink: { color: colors.accent, fontSize: 12, marginTop: 4, fontFamily: fonts.bodySemiBold },
    cardActions: { alignItems: 'flex-end', gap: 6 },
    amount: { fontSize: 15, fontFamily: fonts.monoMedium },
    deleteButton: { backgroundColor: colors.dangerSoft, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
    deleteButtonText: { color: colors.danger, fontSize: 11, fontFamily: fonts.bodySemiBold },
    hint: { color: colors.textFaint, fontSize: 12, textAlign: 'center', marginTop: 8, fontFamily: fonts.body },
  });
}
