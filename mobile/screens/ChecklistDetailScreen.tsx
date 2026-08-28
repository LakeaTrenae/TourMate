/**
 * ChecklistDetailScreen — one checklist's items (tap to check off, hold
 * to delete) plus a running `notes` scratchpad on the checklist itself,
 * for exactly the "things to remember to add or remove" case this
 * feature was built for — separate from the itemized checkboxes so it
 * doesn't get lost among them.
 *
 * Edit rights (checking items, adding/removing them, editing notes) are
 * enforced server-side by can_edit_checklist (0021) — this screen shows
 * the controls to everyone and lets RLS reject an unauthorized write
 * rather than trying to perfectly predict the rule client-side.
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

type Props = NativeStackScreenProps<RootStackParamList, 'ChecklistDetail'>;

type Item = {
  id: string;
  description: string;
  is_checked: boolean;
  position: number;
};

export function ChecklistDetailScreen({ route }: Props) {
  const { checklistId, title } = route.params;
  const { session } = useAuth();

  const [items, setItems] = useState<Item[]>([]);
  const [notes, setNotes] = useState('');
  const [savedNotes, setSavedNotes] = useState('');
  const [newItemText, setNewItemText] = useState('');
  const [addingItem, setAddingItem] = useState(false);
  const [savingNotes, setSavingNotes] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function load() {
    const [{ data: checklistRow, error: checklistError }, { data: itemRows, error: itemError }] = await Promise.all([
      supabase.from('checklists').select('notes').eq('id', checklistId).maybeSingle(),
      supabase.from('checklist_items').select('id, description, is_checked, position').eq('checklist_id', checklistId).order('position', { ascending: true }),
    ]);
    if (checklistError) setErrorMessage(checklistError.message);
    if (itemError) setErrorMessage(itemError.message);
    setNotes(checklistRow?.notes ?? '');
    setSavedNotes(checklistRow?.notes ?? '');
    setItems(itemRows ?? []);
  }

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load().finally(() => setLoading(false));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [checklistId])
  );

  async function handleRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function toggleItem(item: Item) {
    // Optimistic update — feels instant when checking off a long walkthrough
    // list; reverted if the write is rejected (e.g. RLS, or a race with
    // someone else editing the same checklist).
    const nextChecked = !item.is_checked;
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, is_checked: nextChecked } : i)));

    const { error } = await supabase
      .from('checklist_items')
      .update({
        is_checked: nextChecked,
        checked_by: nextChecked ? session?.user.id ?? null : null,
        checked_at: nextChecked ? new Date().toISOString() : null,
      })
      .eq('id', item.id);

    if (error) {
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, is_checked: item.is_checked } : i)));
      setErrorMessage(error.message);
    }
  }

  function confirmDeleteItem(item: Item) {
    Alert.alert('Remove this item?', item.description, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('checklist_items').delete().eq('id', item.id);
          if (error) setErrorMessage(error.message);
          else await load();
        },
      },
    ]);
  }

  async function handleAddItem() {
    if (!newItemText.trim()) return;
    setAddingItem(true);
    const { error } = await supabase.from('checklist_items').insert({
      id: newId(),
      checklist_id: checklistId,
      description: newItemText.trim(),
      position: items.length,
    });
    setAddingItem(false);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    setNewItemText('');
    await load();
  }

  async function handleSaveNotes() {
    setSavingNotes(true);
    const { error } = await supabase.from('checklists').update({ notes: notes.trim() || null }).eq('id', checklistId);
    setSavingNotes(false);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    setSavedNotes(notes);
  }

  const checkedCount = items.filter((i) => i.is_checked).length;
  const notesDirty = notes !== savedNotes;

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#fff" />}
    >
      <Text style={styles.title}>{title}</Text>
      {items.length > 0 && (
        <Text style={styles.progress}>
          {checkedCount}/{items.length} done
        </Text>
      )}

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      {items.length === 0 ? (
        <Text style={styles.emptyText}>No items yet — add the first one below.</Text>
      ) : (
        items.map((item) => (
          <Pressable
            key={item.id}
            style={styles.itemRow}
            onPress={() => toggleItem(item)}
            onLongPress={() => confirmDeleteItem(item)}
          >
            <View style={[styles.checkbox, item.is_checked && styles.checkboxChecked]}>
              {item.is_checked && <Text style={styles.checkmark}>✓</Text>}
            </View>
            <Text style={[styles.itemText, item.is_checked && styles.itemTextChecked]}>{item.description}</Text>
            <Pressable style={styles.deleteButton} onPress={() => confirmDeleteItem(item)}>
              <Text style={styles.deleteButtonText}>✕</Text>
            </Pressable>
          </Pressable>
        ))
      )}
      {items.length > 0 && <Text style={styles.hint}>Tap to check off · tap ✕ (or hold) to remove.</Text>}

      <View style={styles.addItemRow}>
        <TextInput
          style={styles.addItemInput}
          placeholder="Add an item…"
          placeholderTextColor="#6b6b76"
          value={newItemText}
          onChangeText={setNewItemText}
          onSubmitEditing={handleAddItem}
          returnKeyType="done"
        />
        <Pressable style={styles.addItemButton} onPress={handleAddItem} disabled={addingItem || !newItemText.trim()}>
          {addingItem ? <ActivityIndicator color="#0b0b0f" /> : <Text style={styles.addItemButtonText}>Add</Text>}
        </Pressable>
      </View>

      <Text style={styles.sectionTitle}>Notes</Text>
      <Text style={styles.notesHint}>Things to remember to add or remove, follow-ups, anything that doesn't fit as a checkbox.</Text>
      <TextInput
        style={styles.notesInput}
        placeholder="Nothing noted yet…"
        placeholderTextColor="#6b6b76"
        value={notes}
        onChangeText={setNotes}
        multiline
        numberOfLines={5}
      />
      {notesDirty && (
        <Pressable style={styles.saveNotesButton} onPress={handleSaveNotes} disabled={savingNotes}>
          {savingNotes ? <ActivityIndicator color="#0b0b0f" /> : <Text style={styles.saveNotesButtonText}>Save Notes</Text>}
        </Pressable>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b0f' },
  centered: { flex: 1, backgroundColor: '#0b0b0f', alignItems: 'center', justifyContent: 'center' },
  content: { padding: 20, paddingBottom: 60 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700' },
  progress: { color: '#6b6b76', fontSize: 13, marginTop: 4, marginBottom: 12 },
  error: { color: '#ff6b6b', fontSize: 13, marginBottom: 12 },
  emptyText: { color: '#6b6b76', fontSize: 14, marginTop: 12, marginBottom: 12 },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1a1a20',
    borderRadius: 10,
    padding: 14,
    marginTop: 8,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#6b6b76',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  checkboxChecked: { backgroundColor: '#7ee787', borderColor: '#7ee787' },
  checkmark: { color: '#0b0b0f', fontSize: 14, fontWeight: '700' },
  itemText: { color: '#fff', fontSize: 14, flex: 1 },
  itemTextChecked: { color: '#6b6b76', textDecorationLine: 'line-through' },
  deleteButton: { paddingHorizontal: 10, paddingVertical: 4, marginLeft: 8 },
  deleteButtonText: { color: '#ff6b6b', fontSize: 16, fontWeight: '700' },
  hint: { color: '#6b6b76', fontSize: 12, textAlign: 'center', marginTop: 8 },
  addItemRow: { flexDirection: 'row', gap: 8, marginTop: 16 },
  addItemInput: {
    flex: 1,
    backgroundColor: '#1a1a20',
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
  },
  addItemButton: {
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingHorizontal: 18,
    justifyContent: 'center',
  },
  addItemButtonText: { color: '#0b0b0f', fontSize: 14, fontWeight: '600' },
  sectionTitle: { color: '#9a9aa5', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', marginTop: 28, marginBottom: 4 },
  notesHint: { color: '#6b6b76', fontSize: 12, marginBottom: 8 },
  notesInput: {
    backgroundColor: '#1a1a20',
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    minHeight: 110,
    textAlignVertical: 'top',
  },
  saveNotesButton: { backgroundColor: '#fff', borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 10 },
  saveNotesButtonText: { color: '#0b0b0f', fontSize: 14, fontWeight: '600' },
});
