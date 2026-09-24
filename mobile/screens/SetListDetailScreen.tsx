/**
 * SetListDetailScreen — one set list's running order (reorderable — song
 * order is the entire point, unlike a checklist), a print-template picker
 * ("Print Customization & Stock Templates"), a running notes scratchpad,
 * and Print. Edit rights enforced server-side by can_edit_setlist (0040)
 * — this screen shows the controls to everyone and lets RLS reject an
 * unauthorized write, same philosophy as ChecklistDetailScreen.
 *
 * Theme (Manrope/JetBrains Mono, navy accent) per the "Load-In" design
 * review — see lib/theme.tsx.
 */
import { useCallback, useMemo, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import * as Print from 'expo-print';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { supabase } from '../lib/supabase';
import { newId } from '../lib/ids';
import { formatDateOnly } from '../lib/dates';
import { buildSetlistHtml, type SetlistData } from '../lib/dayPrint';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'SetListDetail'>;

type Item = { id: string; title: string; notes: string | null; position: number };
type Template = 'standard' | 'large_print' | 'compact';
const TEMPLATES: { value: Template; label: string }[] = [
  { value: 'standard', label: 'Standard' },
  { value: 'large_print', label: 'Large Print (stage)' },
  { value: 'compact', label: 'Compact' },
];

export function SetListDetailScreen({ route }: Props) {
  const { setlistId, name } = route.params;
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [items, setItems] = useState<Item[]>([]);
  const [notes, setNotes] = useState('');
  const [savedNotes, setSavedNotes] = useState('');
  const [template, setTemplate] = useState<Template>('standard');
  const [artistName, setArtistName] = useState<string | null>(null);
  const [tourName, setTourName] = useState('');
  const [dateLabel, setDateLabel] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [newNote, setNewNote] = useState('');
  const [addingItem, setAddingItem] = useState(false);
  const [savingNotes, setSavingNotes] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function load() {
    const [{ data: setlistRow, error: setlistError }, { data: itemRows, error: itemError }] = await Promise.all([
      supabase
        .from('setlists')
        .select('notes, template, artist:artists(name), tour:tours(name), tour_date:tour_dates(date)')
        .eq('id', setlistId)
        .maybeSingle(),
      supabase.from('setlist_items').select('id, title, notes, position').eq('setlist_id', setlistId).order('position', { ascending: true }),
    ]);
    if (setlistError) setErrorMessage(setlistError.message);
    if (itemError) setErrorMessage(itemError.message);
    const row = setlistRow as unknown as {
      notes: string | null;
      template: Template;
      artist: { name: string } | null;
      tour: { name: string } | null;
      tour_date: { date: string } | null;
    } | null;
    setNotes(row?.notes ?? '');
    setSavedNotes(row?.notes ?? '');
    setTemplate(row?.template ?? 'standard');
    setArtistName(row?.artist?.name ?? null);
    setTourName(row?.tour?.name ?? '');
    setDateLabel(row?.tour_date ? formatDateOnly(row.tour_date.date, { weekday: 'long', month: 'long', day: 'numeric' }) : null);
    setItems(itemRows ?? []);
  }

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load().finally(() => setLoading(false));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [setlistId])
  );

  async function handleRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function handleAddItem() {
    if (!newTitle.trim()) return;
    setAddingItem(true);
    const { error } = await supabase.from('setlist_items').insert({
      id: newId(),
      setlist_id: setlistId,
      title: newTitle.trim(),
      notes: newNote.trim() || null,
      position: items.length,
    });
    setAddingItem(false);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    setNewTitle('');
    setNewNote('');
    await load();
  }

  function confirmDeleteItem(item: Item) {
    Alert.alert('Remove this song?', item.title, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('setlist_items').delete().eq('id', item.id);
          if (error) setErrorMessage(error.message);
          else await load();
        },
      },
    ]);
  }

  // Swaps position with the neighbor and writes both rows — a setlist is
  // short enough (a couple dozen songs at most) that this two-write swap
  // is simpler and plenty fast, vs. renumbering the whole list.
  async function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const a = items[index];
    const b = items[target];
    const next = [...items];
    next[index] = { ...b, position: a.position };
    next[target] = { ...a, position: b.position };
    setItems(next.sort((x, y) => x.position - y.position));
    await Promise.all([
      supabase.from('setlist_items').update({ position: b.position }).eq('id', a.id),
      supabase.from('setlist_items').update({ position: a.position }).eq('id', b.id),
    ]);
  }

  async function handleSaveNotes() {
    setSavingNotes(true);
    const { error } = await supabase.from('setlists').update({ notes: notes.trim() || null }).eq('id', setlistId);
    setSavingNotes(false);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    setSavedNotes(notes);
  }

  async function handleTemplateChange(t: Template) {
    setTemplate(t);
    await supabase.from('setlists').update({ template: t }).eq('id', setlistId);
  }

  async function handlePrint() {
    setPrinting(true);
    try {
      const data: SetlistData = {
        name,
        artistName,
        tourName,
        dateLabel,
        template,
        items: items.map((i) => ({ title: i.title, notes: i.notes })),
        notes: notes.trim() || null,
      };
      await Print.printAsync({ html: buildSetlistHtml(data) });
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to print.');
    }
    setPrinting(false);
  }

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
      <Text style={styles.title}>{name}</Text>
      {(artistName || dateLabel) && (
        <Text style={styles.subtitle}>{[artistName, dateLabel].filter(Boolean).join(' · ')}</Text>
      )}

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      {items.length === 0 ? (
        <Text style={styles.emptyText}>No songs yet — add the first one below.</Text>
      ) : (
        items.map((item, index) => (
          <View key={item.id} style={styles.itemRow}>
            <Text style={styles.itemNumber}>{index + 1}</Text>
            <View style={styles.itemMain}>
              <Text style={styles.itemText}>{item.title}</Text>
              {item.notes && <Text style={styles.itemNote}>{item.notes}</Text>}
            </View>
            <View style={styles.itemControls}>
              <Pressable style={styles.moveButton} onPress={() => move(index, -1)} disabled={index === 0}>
                <Text style={[styles.moveButtonText, index === 0 && styles.moveButtonDisabled]}>↑</Text>
              </Pressable>
              <Pressable style={styles.moveButton} onPress={() => move(index, 1)} disabled={index === items.length - 1}>
                <Text style={[styles.moveButtonText, index === items.length - 1 && styles.moveButtonDisabled]}>↓</Text>
              </Pressable>
              <Pressable style={styles.deleteButton} onPress={() => confirmDeleteItem(item)}>
                <Text style={styles.deleteButtonText}>✕</Text>
              </Pressable>
            </View>
          </View>
        ))
      )}

      <View style={styles.addForm}>
        <TextInput
          style={styles.input}
          placeholder="Song title (or a cue like ENCORE BREAK)"
          placeholderTextColor={colors.textFaint}
          value={newTitle}
          onChangeText={setNewTitle}
        />
        <TextInput
          style={styles.input}
          placeholder="Notes (key, segue, tech cue…) — optional"
          placeholderTextColor={colors.textFaint}
          value={newNote}
          onChangeText={setNewNote}
        />
        <Pressable style={styles.addButton} onPress={handleAddItem} disabled={addingItem || !newTitle.trim()}>
          {addingItem ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.addButtonText}>Add Song</Text>}
        </Pressable>
      </View>

      <Text style={styles.sectionTitle}>Print Template</Text>
      <View style={styles.chipRow}>
        {TEMPLATES.map((t) => (
          <Pressable key={t.value} style={[styles.chip, template === t.value && styles.chipActive]} onPress={() => handleTemplateChange(t.value)}>
            <Text style={[styles.chipText, template === t.value && styles.chipTextActive]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.sectionTitle}>Notes</Text>
      <TextInput
        style={styles.notesInput}
        placeholder="Anything that doesn't fit as a song cue…"
        placeholderTextColor={colors.textFaint}
        value={notes}
        onChangeText={setNotes}
        multiline
        numberOfLines={4}
      />
      {notesDirty && (
        <Pressable style={styles.saveNotesButton} onPress={handleSaveNotes} disabled={savingNotes}>
          {savingNotes ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.saveNotesButtonText}>Save Notes</Text>}
        </Pressable>
      )}

      <Pressable style={styles.printButton} onPress={handlePrint} disabled={printing || items.length === 0}>
        {printing ? <ActivityIndicator color={colors.accent} /> : <Text style={styles.printButtonText}>Print Set List</Text>}
      </Pressable>
    </ScrollView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    centered: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
    content: { padding: 20, paddingBottom: 60 },
    title: { color: colors.text, fontSize: 22, fontFamily: fonts.displayBold },
    subtitle: { color: colors.textDim, fontSize: 13, marginTop: 4, marginBottom: 12, fontFamily: fonts.body },
    error: { color: colors.danger, fontSize: 13, marginBottom: 12, fontFamily: fonts.body },
    emptyText: { color: colors.textFaint, fontSize: 14, marginTop: 12, marginBottom: 12, fontFamily: fonts.body },
    itemRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: 10,
      padding: 12,
      marginTop: 6,
    },
    itemNumber: { color: colors.textFaint, fontSize: 13, fontFamily: fonts.mono, width: 22 },
    itemMain: { flex: 1 },
    itemText: { color: colors.text, fontSize: 15, fontFamily: fonts.bodySemiBold },
    itemNote: { color: colors.textDim, fontSize: 12, marginTop: 2, fontFamily: fonts.body },
    itemControls: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    moveButton: { paddingHorizontal: 8, paddingVertical: 6 },
    moveButtonText: { color: colors.accent, fontSize: 16, fontFamily: fonts.bodyBold },
    moveButtonDisabled: { color: colors.textFaint },
    deleteButton: { paddingHorizontal: 8, paddingVertical: 6, marginLeft: 4 },
    deleteButtonText: { color: colors.danger, fontSize: 15, fontFamily: fonts.bodyBold },
    addForm: { backgroundColor: colors.surface, borderRadius: 10, padding: 12, marginTop: 16, gap: 8, borderWidth: 1, borderColor: colors.border },
    input: {
      backgroundColor: colors.surface2,
      color: colors.text,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 14,
      fontFamily: fonts.body,
    },
    addButton: { backgroundColor: colors.accent, borderRadius: 8, paddingVertical: 11, alignItems: 'center' },
    addButtonText: { color: colors.onAccent, fontSize: 14, fontFamily: fonts.bodySemiBold },
    sectionTitle: { color: colors.textDim, fontSize: 12, fontFamily: fonts.bodySemiBold, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 24, marginBottom: 8 },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: { backgroundColor: colors.surface2, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 },
    chipActive: { backgroundColor: colors.accent },
    chipText: { color: colors.textDim, fontSize: 13, fontFamily: fonts.bodySemiBold },
    chipTextActive: { color: colors.onAccent },
    notesInput: {
      backgroundColor: colors.surface,
      color: colors.text,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 14,
      fontFamily: fonts.body,
      minHeight: 90,
      textAlignVertical: 'top',
      borderWidth: 1,
      borderColor: colors.border,
    },
    saveNotesButton: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 10 },
    saveNotesButtonText: { color: colors.onAccent, fontSize: 14, fontFamily: fonts.bodySemiBold },
    printButton: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 24 },
    printButtonText: { color: colors.accent, fontSize: 15, fontFamily: fonts.bodySemiBold },
  });
}
