/**
 * AddChecklistScreen — create a new checklist (venue walkthrough,
 * hospitality & rider notes, load-in, whatever). Items get added
 * afterward on ChecklistDetailScreen, not here — keeping creation to
 * "title + who owns it + who can see it" keeps this form short.
 */
import { useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { supabase } from '../lib/supabase';
import { newId } from '../lib/ids';
import { formatDepartment } from '../lib/format';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'AddChecklist'>;

const DEPARTMENTS = ['general', 'production', 'security', 'travel', 'artist_relations', 'finance', 'tour_management'];

// A couple of common starting points so nobody has to type "stage power"
// and "parking" from scratch every tour — picking one pre-fills items,
// but the title/department/visibility are still theirs to set.
const TEMPLATES: { label: string; title: string; department: string; items: string[] }[] = [
  {
    label: 'Venue Walkthrough',
    title: 'Venue Walkthrough',
    department: 'production',
    items: [
      'Stage dimensions & load-in path',
      'Power (amps, distro location)',
      'Loading dock / parking access',
      'Dressing rooms & green room',
      'Front-of-house & mix position',
      'Wifi / network access',
      'Security office & emergency exits',
      'Medical station location',
      'Restrooms (crew + guest)',
      'Catering / hospitality space',
      'Merch location',
      'Local noise curfew / restrictions',
    ],
  },
  {
    label: 'Hospitality & Rider',
    title: 'Hospitality & Rider Notes',
    department: 'production',
    items: [
      'Technical rider sent to venue',
      'Hospitality rider sent to venue',
      'Catering confirmed (headcount + time)',
      'Green room requests confirmed',
      'Local crew / runners confirmed',
      'Towels & water at FOH and stage',
      'Dietary restrictions communicated',
    ],
  },
];

export function AddChecklistScreen({ route, navigation }: Props) {
  const { tourId } = route.params;

  const [title, setTitle] = useState('');
  const [department, setDepartment] = useState('production');
  const [visibleToAll, setVisibleToAll] = useState(true);
  const [items, setItems] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function applyTemplate(template: (typeof TEMPLATES)[number]) {
    setTitle(template.title);
    setDepartment(template.department);
    setItems(template.items);
  }

  async function handleSubmit() {
    setErrorMessage(null);
    if (!title.trim()) {
      setErrorMessage('Give this checklist a title.');
      return;
    }

    setSubmitting(true);

    const checklistId = newId();
    const { error: checklistError } = await supabase.from('checklists').insert({
      id: checklistId,
      tour_id: tourId,
      title: title.trim(),
      department,
      visible_to_all: visibleToAll,
    });
    if (checklistError) {
      setSubmitting(false);
      setErrorMessage(checklistError.message);
      return;
    }

    if (items.length > 0) {
      const { error: itemsError } = await supabase.from('checklist_items').insert(
        items.map((description, index) => ({
          id: newId(),
          checklist_id: checklistId,
          description,
          position: index,
        }))
      );
      if (itemsError) {
        setSubmitting(false);
        setErrorMessage(`Checklist created, but starting items failed: ${itemsError.message}`);
        return;
      }
    }

    setSubmitting(false);
    navigation.goBack();
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>New Checklist</Text>

      <Text style={styles.sectionTitle}>Start from a template (optional)</Text>
      <View style={styles.templateRow}>
        {TEMPLATES.map((t) => (
          <Pressable key={t.label} style={styles.templateChip} onPress={() => applyTemplate(t)}>
            <Text style={styles.templateChipText}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      <TextInput
        style={styles.input}
        placeholder="Checklist title"
        placeholderTextColor="#6b6b76"
        value={title}
        onChangeText={setTitle}
      />

      <Text style={styles.sectionTitle}>Department (owns editing)</Text>
      <View style={styles.chipRow}>
        {DEPARTMENTS.map((d) => (
          <Pressable
            key={d}
            style={[styles.chip, department === d && styles.chipActive]}
            onPress={() => setDepartment(d)}
          >
            <Text style={[styles.chipText, department === d && styles.chipTextActive]}>{formatDepartment(d)}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.sectionTitle}>Who can see it</Text>
      <View style={styles.chipRow}>
        <Pressable style={[styles.chip, visibleToAll && styles.chipActive]} onPress={() => setVisibleToAll(true)}>
          <Text style={[styles.chipText, visibleToAll && styles.chipTextActive]}>Everyone on the tour</Text>
        </Pressable>
        <Pressable style={[styles.chip, !visibleToAll && styles.chipActive]} onPress={() => setVisibleToAll(false)}>
          <Text style={[styles.chipText, !visibleToAll && styles.chipTextActive]}>Managers + this department</Text>
        </Pressable>
      </View>

      {items.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>Starting items ({items.length})</Text>
          <Text style={styles.templateHint}>You can add, edit, or remove items after creating the checklist.</Text>
        </>
      )}

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <Pressable style={styles.submitButton} onPress={handleSubmit} disabled={submitting}>
        {submitting ? <ActivityIndicator color="#0b0b0f" /> : <Text style={styles.submitButtonText}>Create Checklist</Text>}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b0f' },
  content: { padding: 20, paddingBottom: 60 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700', marginBottom: 16 },
  sectionTitle: { color: '#9a9aa5', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', marginTop: 14, marginBottom: 8 },
  templateHint: { color: '#6b6b76', fontSize: 12, marginTop: -4, marginBottom: 4 },
  templateRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  templateChip: {
    backgroundColor: '#15151a',
    borderWidth: 1,
    borderColor: '#2a2a32',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  templateChipText: { color: '#7c9cff', fontSize: 13, fontWeight: '600' },
  input: {
    backgroundColor: '#1a1a20',
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 4,
    fontSize: 15,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { backgroundColor: '#1a1a20', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 },
  chipActive: { backgroundColor: '#fff' },
  chipText: { color: '#9a9aa5', fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: '#0b0b0f' },
  error: { color: '#ff6b6b', fontSize: 13, marginTop: 12 },
  submitButton: { backgroundColor: '#fff', borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 20 },
  submitButtonText: { color: '#0b0b0f', fontSize: 16, fontWeight: '600' },
});
