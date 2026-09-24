/**
 * ImportBudgetScreen — pick a budget document (PDF, photo, or
 * spreadsheet), send it to the extract-budget edge function for AI
 * extraction, then let the manager review and edit every row before
 * anything is written to the database. Same idle → extracting → review →
 * importing phase machine as ImportScheduleScreen — the extraction is a
 * starting point, not a commit.
 *
 * date_label matching: each extracted date_label gets resolved against
 * the tour's own tour_dates (exact date match) to fill in tour_date_id —
 * a miss just leaves the entry tour-wide rather than blocking the import,
 * same "best effort, never blocking" spirit as ImportScheduleScreen's
 * venue resolution.
 *
 * Theme (Manrope/JetBrains Mono, navy accent) per the "Load-In" design
 * review — see lib/theme.tsx.
 */
import { useMemo, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as DocumentPicker from 'expo-document-picker';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { supabase } from '../lib/supabase';
import { readFileAsBase64 } from '../lib/files';
import { newId } from '../lib/ids';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'ImportBudget'>;
type Styles = ReturnType<typeof createStyles>;

type ExtractedItem = {
  key: string;
  category: string;
  description: string;
  amount: string;
  entry_type: 'income' | 'expense';
  date_label: string;
  notes: string;
};

type RawItem = {
  category: string;
  description: string | null;
  amount: number;
  entry_type: 'income' | 'expense';
  date_label: string | null;
  notes: string | null;
};

export function ImportBudgetScreen({ route, navigation }: Props) {
  const { tourId } = route.params;
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [phase, setPhase] = useState<'idle' | 'extracting' | 'review' | 'importing'>('idle');
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<ExtractedItem[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handlePickAndExtract() {
    setErrorMessage(null);
    const result = await DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true });
    if (result.canceled || result.assets.length === 0) return;
    const asset = result.assets[0];

    setFileName(asset.name);
    setPhase('extracting');

    try {
      const base64Data = await readFileAsBase64(asset.uri);
      const { data, error } = await supabase.functions.invoke('extract-budget', {
        body: { tourId, fileName: asset.name, mimeType: asset.mimeType ?? 'application/octet-stream', base64Data },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      const raw: RawItem[] = data?.items ?? [];
      if (raw.length === 0) {
        setErrorMessage("Couldn't find any budget line items in that document. Try a clearer file, or add entries manually.");
        setPhase('idle');
        return;
      }

      setRows(
        raw.map((r) => ({
          key: newId(),
          category: r.category ?? '',
          description: r.description ?? '',
          amount: r.amount != null ? String(r.amount) : '',
          entry_type: r.entry_type === 'income' ? 'income' : 'expense',
          date_label: r.date_label ?? '',
          notes: r.notes ?? '',
        }))
      );
      setPhase('review');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Extraction failed.');
      setPhase('idle');
    }
  }

  function updateRow(key: string, field: keyof ExtractedItem, value: string) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  }

  function toggleType(key: string) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, entry_type: r.entry_type === 'income' ? 'expense' : 'income' } : r)));
  }

  function removeRow(key: string) {
    setRows((prev) => prev.filter((r) => r.key !== key));
  }

  async function handleImport() {
    setErrorMessage(null);
    if (rows.length === 0) return;

    const invalidAmount = rows.find((r) => Number.isNaN(parseFloat(r.amount)) || parseFloat(r.amount) <= 0);
    if (invalidAmount) {
      setErrorMessage(`"${invalidAmount.category}" has an invalid amount — fix it before importing.`);
      return;
    }

    setPhase('importing');

    // Resolve each date_label against this tour's own dates — a match
    // fills in tour_date_id for the per-week/per-show breakdown; a miss
    // (no date, or no matching show) just leaves the entry tour-wide.
    const { data: dateRows, error: dateError } = await supabase.from('tour_dates').select('id, date').eq('tour_id', tourId);
    if (dateError) {
      setPhase('review');
      setErrorMessage(dateError.message);
      return;
    }
    const dateMap = new Map((dateRows ?? []).map((d) => [d.date, d.id]));

    const { error } = await supabase.from('budget_items').insert(
      rows.map((r) => ({
        tour_id: tourId,
        category: r.category.trim() || 'Uncategorized',
        description: [r.description.trim(), r.notes.trim()].filter(Boolean).join(' — ') || null,
        amount: parseFloat(r.amount),
        entry_type: r.entry_type,
        tour_date_id: dateMap.get(r.date_label.trim()) ?? null,
      }))
    );
    setPhase('review');

    if (error) {
      setErrorMessage(error.message);
      return;
    }
    navigation.goBack();
  }

  if (phase === 'idle') {
    return (
      <View style={styles.centeredContainer}>
        <Text style={styles.title}>Import Budget</Text>
        <Text style={styles.subtitle}>
          Upload a production budget — a spreadsheet, a PDF, or even a photo of a printed budget — and we'll pull
          out the line items for you to review before anything's added.
        </Text>
        {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}
        <Pressable style={styles.pickButton} onPress={handlePickAndExtract}>
          <Text style={styles.pickButtonText}>Choose a file</Text>
        </Pressable>
      </View>
    );
  }

  if (phase === 'extracting') {
    return (
      <View style={styles.centeredContainer}>
        <ActivityIndicator color={colors.accent} size="large" />
        <Text style={styles.subtitle}>Reading {fileName}…</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Review before importing</Text>
      <Text style={styles.subtitle}>
        Found {rows.length} line item{rows.length === 1 ? '' : 's'} in {fileName}. Check everything below — nothing's
        saved yet.
      </Text>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      {rows.map((row, index) => (
        <View key={row.key} style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardIndex}>Item {index + 1}</Text>
            <Pressable onPress={() => removeRow(row.key)}>
              <Text style={styles.removeText}>Remove</Text>
            </Pressable>
          </View>

          <Pressable style={[styles.typeToggle, row.entry_type === 'income' ? styles.typeToggleIncome : styles.typeToggleExpense]} onPress={() => toggleType(row.key)}>
            <Text style={styles.typeToggleText}>{row.entry_type === 'income' ? 'Income (tap to switch)' : 'Expense (tap to switch)'}</Text>
          </Pressable>

          <Field styles={styles} colors={colors} label="Category" value={row.category} onChange={(v) => updateRow(row.key, 'category', v)} />
          <Field styles={styles} colors={colors} label="Description" value={row.description} onChange={(v) => updateRow(row.key, 'description', v)} />
          <View style={styles.row}>
            <Field styles={styles} colors={colors} label="Amount" value={row.amount} onChange={(v) => updateRow(row.key, 'amount', v)} flex />
            <Field styles={styles} colors={colors} label="Show date (YYYY-MM-DD)" value={row.date_label} onChange={(v) => updateRow(row.key, 'date_label', v)} flex />
          </View>
          <Field styles={styles} colors={colors} label="Notes" value={row.notes} onChange={(v) => updateRow(row.key, 'notes', v)} />
        </View>
      ))}

      <Pressable style={styles.importButton} onPress={handleImport} disabled={phase === 'importing' || rows.length === 0}>
        {phase === 'importing' ? (
          <ActivityIndicator color={colors.onAccent} />
        ) : (
          <Text style={styles.importButtonText}>Import {rows.length} Item{rows.length === 1 ? '' : 's'}</Text>
        )}
      </Pressable>
    </ScrollView>
  );
}

function Field({
  label,
  value,
  onChange,
  flex,
  styles,
  colors,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  flex?: boolean;
  styles: Styles;
  colors: ThemeColors;
}) {
  return (
    <View style={flex ? styles.fieldFlex : styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput style={styles.fieldInput} value={value} onChangeText={onChange} placeholder="—" placeholderTextColor={colors.textFaint} />
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    centeredContainer: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
    content: { padding: 20, paddingBottom: 60 },
    title: { color: colors.text, fontSize: 22, fontFamily: fonts.displayBold, marginBottom: 8, textAlign: 'center' },
    subtitle: { color: colors.textDim, fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 16, fontFamily: fonts.body },
    error: { color: colors.danger, fontSize: 13, textAlign: 'center', marginBottom: 12, fontFamily: fonts.body },
    pickButton: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 14, paddingHorizontal: 28, marginTop: 8 },
    pickButtonText: { color: colors.onAccent, fontSize: 16, fontFamily: fonts.bodySemiBold },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 12,
      padding: 14,
      marginBottom: 12,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.08,
      shadowRadius: 10,
      elevation: 2,
    },
    cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
    cardIndex: { color: colors.textDim, fontSize: 12, fontFamily: fonts.bodySemiBold, textTransform: 'uppercase', letterSpacing: 0.5 },
    removeText: { color: colors.danger, fontSize: 12, fontFamily: fonts.bodySemiBold },
    typeToggle: { borderRadius: 8, paddingVertical: 8, alignItems: 'center', marginBottom: 8 },
    typeToggleIncome: { backgroundColor: colors.successSoft },
    typeToggleExpense: { backgroundColor: colors.dangerSoft },
    typeToggleText: { color: colors.text, fontSize: 12, fontFamily: fonts.bodySemiBold },
    row: { flexDirection: 'row', gap: 10 },
    field: { marginBottom: 8 },
    fieldFlex: { flex: 1, marginBottom: 8 },
    fieldLabel: { color: colors.textFaint, fontSize: 11, marginBottom: 3, fontFamily: fonts.body },
    fieldInput: {
      backgroundColor: colors.bg,
      color: colors.text,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
      fontSize: 14,
      fontFamily: fonts.body,
      borderWidth: 1,
      borderColor: colors.border,
    },
    importButton: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
    importButtonText: { color: colors.onAccent, fontSize: 16, fontFamily: fonts.bodySemiBold },
  });
}
