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
 */
import { useState } from 'react';
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
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'AddBudgetItem'>;

type PickedReceipt = { uri: string; name: string; mimeType: string | null };

export function AddBudgetItemScreen({ route, navigation }: Props) {
  const { tourId } = route.params;
  const { session } = useAuth();

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

      <TextInput style={styles.input} placeholder="Category — e.g. Travel, Merch, Guarantee" placeholderTextColor="#6b6b76" value={category} onChangeText={setCategory} />
      <TextInput style={styles.input} placeholder="Description (optional)" placeholderTextColor="#6b6b76" value={description} onChangeText={setDescription} />
      <TextInput
        style={styles.input}
        placeholder="Amount (USD)"
        placeholderTextColor="#6b6b76"
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
      />

      <Pressable style={styles.receiptPicker} onPress={handlePickReceipt}>
        <Text style={styles.receiptPickerText}>{receipt ? `📎 ${receipt.name}` : 'Attach a receipt (optional)'}</Text>
      </Pressable>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <Pressable style={styles.submitButton} onPress={handleSubmit} disabled={submitting}>
        {submitting ? <ActivityIndicator color="#0b0b0f" /> : <Text style={styles.submitButtonText}>Add Entry</Text>}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b0f' },
  content: { padding: 20, paddingBottom: 60 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700', marginBottom: 16 },
  typeToggle: { flexDirection: 'row', gap: 10, marginBottom: 14 },
  typeButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#1a1a20',
  },
  typeButtonSelectedExpense: { backgroundColor: '#3a1e1e' },
  typeButtonSelectedIncome: { backgroundColor: '#1e3a24' },
  typeButtonText: { color: '#9a9aa5', fontSize: 14, fontWeight: '600' },
  typeButtonTextSelected: { color: '#fff' },
  input: {
    backgroundColor: '#1a1a20',
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 10,
    fontSize: 15,
  },
  receiptPicker: {
    backgroundColor: '#1a1a20',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2a2a32',
    borderStyle: 'dashed',
    paddingVertical: 14,
    paddingHorizontal: 14,
    marginTop: 4,
    alignItems: 'center',
  },
  receiptPickerText: { color: '#9a9aa5', fontSize: 14 },
  error: { color: '#ff6b6b', fontSize: 13, marginTop: 8 },
  submitButton: {
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 16,
  },
  submitButtonText: { color: '#0b0b0f', fontSize: 16, fontWeight: '600' },
});
