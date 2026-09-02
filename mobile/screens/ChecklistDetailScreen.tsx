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
import { newId } from '../lib/ids';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
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
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

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
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.accent} />}
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
          placeholderTextColor={colors.textFaint}
          value={newItemText}
          onChangeText={setNewItemText}
          onSubmitEditing={handleAddItem}
          returnKeyType="done"
        />
        <Pressable style={styles.addItemButton} onPress={handleAddItem} disabled={addingItem || !newItemText.trim()}>
          {addingItem ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.addItemButtonText}>Add</Text>}
        </Pressable>
      </View>

      <Text style={styles.sectionTitle}>Notes</Text>
      <Text style={styles.notesHint}>Things to remember to add or remove, follow-ups, anything that doesn't fit as a checkbox.</Text>
      <TextInput
        style={styles.notesInput}
        placeholder="Nothing noted yet…"
        placeholderTextColor={colors.textFaint}
        value={notes}
        onChangeText={setNotes}
        multiline
        numberOfLines={5}
      />
      {notesDirty && (
        <Pressable style={styles.saveNotesButton} onPress={handleSaveNotes} disabled={savingNotes}>
          {savingNotes ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.saveNotesButtonText}>Save Notes</Text>}
        </Pressable>
      )}
    </ScrollView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    centered: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
    content: { padding: 20, paddingBottom: 60 },
    title: { color: colors.text, fontSize: 22, fontFamily: fonts.displayBold },
    progress: { color: colors.textFaint, fontSize: 13, marginTop: 4, marginBottom: 12, fontFamily: fonts.mono },
    error: { color: colors.danger, fontSize: 13, marginBottom: 12, fontFamily: fonts.body },
    emptyText: { color: colors.textFaint, fontSize: 14, marginTop: 12, marginBottom: 12, fontFamily: fonts.body },
    itemRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: 10,
      padding: 14,
      marginTop: 8,
    },
    checkbox: {
      width: 22,
      height: 22,
      borderRadius: 6,
      borderWidth: 2,
      borderColor: colors.textFaint,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 12,
    },
    checkboxChecked: { backgroundColor: colors.success, borderColor: colors.success },
    checkmark: { color: colors.onAccent, fontSize: 14, fontFamily: fonts.bodyBold },
    itemText: { color: colors.text, fontSize: 14, flex: 1, fontFamily: fonts.body },
    itemTextChecked: { color: colors.textFaint, textDecorationLine: 'line-through' },
    deleteButton: { paddingHorizontal: 10, paddingVertical: 4, marginLeft: 8 },
    deleteButtonText: { color: colors.danger, fontSize: 16, fontFamily: fonts.bodyBold },
    hint: { color: colors.textFaint, fontSize: 12, textAlign: 'center', marginTop: 8, fontFamily: fonts.body },
    addItemRow: { flexDirection: 'row', gap: 8, marginTop: 16 },
    addItemInput: {
      flex: 1,
      backgroundColor: colors.surface,
      color: colors.text,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 14,
      fontFamily: fonts.body,
      borderWidth: 1,
      borderColor: colors.border,
    },
    addItemButton: {
      backgroundColor: colors.accent,
      borderRadius: 10,
      paddingHorizontal: 18,
      justifyContent: 'center',
    },
    addItemButtonText: { color: colors.onAccent, fontSize: 14, fontFamily: fonts.bodySemiBold },
    sectionTitle: { color: colors.textDim, fontSize: 12, fontFamily: fonts.bodySemiBold, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 28, marginBottom: 4 },
    notesHint: { color: colors.textFaint, fontSize: 12, marginBottom: 8, fontFamily: fonts.body },
    notesInput: {
      backgroundColor: colors.surface,
      color: colors.text,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 14,
      fontFamily: fonts.body,
      minHeight: 110,
      textAlignVertical: 'top',
      borderWidth: 1,
      borderColor: colors.border,
    },
    saveNotesButton: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 10 },
    saveNotesButtonText: { color: colors.onAccent, fontSize: 14, fontFamily: fonts.bodySemiBold },
  });
}
