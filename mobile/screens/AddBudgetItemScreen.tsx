/**
 * AddBudgetItemScreen — record an income or expense entry, optionally
 * with a receipt photo/PDF attached.
 *
 * Same two-step write pattern as AddDocumentScreen: insert the
 * budget_items row first (client-generated id — see lib/ids.ts, needed
 * because budget_items carries the completion-lock trigger, which trips
 * the same insert+representation issue everywhere else in this app), then
 * upload the receipt file to that exact path second. If the upload fails,
 * the row is cleaned up rather than left pointing at a missing file.
 *
 * Theme (Manrope/JetBrains Mono, navy accent) per the "Load-In" design
 * review — see lib/theme.tsx.
 */
import { useMemo, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as DocumentPicker from 'expo-document-picker';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { newId } from '../lib/ids';
import { logAuditEvent } from '../lib/auditLog';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'AddBudgetItem'>;

type PickedReceipt = { uri: string; name: string; mimeType: string | null };

export function AddBudgetItemScreen({ route, navigation }: Props) {
  const { tourId } = route.params;
  const { session } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [entryType, setEntryType] = useState<'income' | 'expense'>('expense');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [receipt, setReceipt] = useState<PickedReceipt | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handlePickReceipt() {
    const result = await DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true });
    if (result.canceled || result.assets.length === 0) return;
    const asset = result.assets[0];
    setReceipt({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType ?? null });
  }

  async function handleSubmit() {
    setErrorMessage(null);
    if (!session) return;

    if (!category.trim()) {
      setErrorMessage('Enter a category.');
      return;
    }
    const parsedAmount = parseFloat(amount);
    if (Number.isNaN(parsedAmount) || parsedAmount <= 0) {
      setErrorMessage('Enter a valid amount greater than 0.');
      return;
    }

    setSubmitting(true);

    const itemId = newId();
    let receiptPath: string | null = null;
    if (receipt) {
      const safeName = receipt.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      receiptPath = `${tourId}/${itemId}-${safeName}`;
    }

    const { error: insertError } = await supabase.from('budget_items').insert({
      id: itemId,
      tour_id: tourId,
      category: category.trim(),
      description: description.trim() || null,
      amount: parsedAmount,
      entry_type: entryType,
      created_by: session.user.id,
      receipt_path: receiptPath,
    });
    if (insertError) {
      setSubmitting(false);
      setErrorMessage(insertError.message);
      return;
    }

    if (receipt && receiptPath) {
      try {
        const response = await fetch(receipt.uri);
        const fileData = await response.arrayBuffer();
        const { error: uploadError } = await supabase.storage
          .from('tour-receipts')
          .upload(receiptPath, fileData, { contentType: receipt.mimeType ?? 'application/octet-stream' });
        if (uploadError) throw uploadError;
      } catch (err) {
        // Upload failed — don't leave a budget entry pointing at a
        // receipt that doesn't exist.
        await supabase.from('budget_items').delete().eq('id', itemId);
        setSubmitting(false);
        setErrorMessage(err instanceof Error ? err.message : 'Receipt upload failed.');
        return;
      }
    }

    logAuditEvent({
      tourId,
      actorId: session.user.id,
      action: 'create',
      resourceType: 'budget_item',
      resourceId: itemId,
      detail: { category: category.trim(), amount: parsedAmount, entry_type: entryType },
    });

    setSubmitting(false);
    navigation.goBack();
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Add Budget Entry</Text>

      <View style={styles.typeToggle}>
        <Pressable
          style={[styles.typeButton, entryType === 'expense' && styles.typeButtonSelectedExpense]}
          onPress={() => setEntryType('expense')}
        >
          <Text style={[styles.typeButtonText, entryType === 'expense' && styles.typeButtonTextSelected]}>Expense</Text>
        </Pressable>
        <Pressable
          style={[styles.typeButton, entryType === 'income' && styles.typeButtonSelectedIncome]}
          onPress={() => setEntryType('income')}
        >
          <Text style={[styles.typeButtonText, entryType === 'income' && styles.typeButtonTextSelected]}>Income</Text>
        </Pressable>
      </View>

      <TextInput style={styles.input} placeholder="Category — e.g. Travel, Merch, Guarantee" placeholderTextColor={colors.textFaint} value={category} onChangeText={setCategory} />
      <TextInput style={styles.input} placeholder="Description (optional)" placeholderTextColor={colors.textFaint} value={description} onChangeText={setDescription} />
      <TextInput
        style={styles.input}
        placeholder="Amount (USD)"
        placeholderTextColor={colors.textFaint}
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
      />

      <Pressable style={styles.receiptPicker} onPress={handlePickReceipt}>
        <Text style={styles.receiptPickerText}>{receipt ? `📎 ${receipt.name}` : 'Attach a receipt (optional)'}</Text>
      </Pressable>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <Pressable style={styles.submitButton} onPress={handleSubmit} disabled={submitting}>
        {submitting ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.submitButtonText}>Add Entry</Text>}
      </Pressable>
    </ScrollView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    content: { padding: 20, paddingBottom: 60 },
    title: { color: colors.text, fontSize: 22, fontFamily: fonts.displayBold, marginBottom: 16 },
    typeToggle: { flexDirection: 'row', gap: 10, marginBottom: 14 },
    typeButton: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: 10,
      borderRadius: 8,
      backgroundColor: colors.surface2,
    },
    typeButtonSelectedExpense: { backgroundColor: colors.dangerSoft },
    typeButtonSelectedIncome: { backgroundColor: colors.successSoft },
    typeButtonText: { color: colors.textDim, fontSize: 14, fontFamily: fonts.bodySemiBold },
    typeButtonTextSelected: { color: colors.text },
    input: {
      backgroundColor: colors.surface,
      color: colors.text,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      marginBottom: 10,
      fontSize: 15,
      fontFamily: fonts.body,
      borderWidth: 1,
      borderColor: colors.border,
    },
    receiptPicker: {
      backgroundColor: colors.surface,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      borderStyle: 'dashed',
      paddingVertical: 14,
      paddingHorizontal: 14,
      marginTop: 4,
      alignItems: 'center',
    },
    receiptPickerText: { color: colors.textDim, fontSize: 14, fontFamily: fonts.body },
    error: { color: colors.danger, fontSize: 13, marginTop: 8, fontFamily: fonts.body },
    submitButton: {
      backgroundColor: colors.accent,
      borderRadius: 10,
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: 16,
    },
    submitButtonText: { color: colors.onAccent, fontSize: 16, fontFamily: fonts.bodySemiBold },
  });
}
