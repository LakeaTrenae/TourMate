/**
 * AddDocumentScreen — pick a file and upload it as a tour document.
 *
 * Two-step write, in this specific order, matching the note in
 * 0013_documents_storage.sql:
 *   1. Insert the `documents` metadata row (client-generated id — see
 *      lib/ids.ts — no chained .select(), same trigger/RETURNING issue
 *      as everywhere else that writes a tour-scoped table).
 *   2. Upload the actual file bytes to that exact storage_path.
 * If step 2 fails, the metadata row is cleaned up rather than left
 * dangling (a document entry with no file behind it).
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

type Props = NativeStackScreenProps<RootStackParamList, 'AddDocument'>;

type PickedFile = { uri: string; name: string; mimeType: string | null };
type Category = 'general' | 'contract' | 'rider' | 'hospitality' | 'itinerary' | 'other';

const CATEGORIES: { value: Category; label: string }[] = [
  { value: 'general', label: 'General' },
  { value: 'contract', label: 'Contract' },
  { value: 'rider', label: 'Rider' },
  { value: 'hospitality', label: 'Hospitality' },
  { value: 'itinerary', label: 'Itinerary' },
  { value: 'other', label: 'Other' },
];

export function AddDocumentScreen({ route, navigation }: Props) {
  const { tourId } = route.params;
  const { session } = useAuth();

  const [file, setFile] = useState<PickedFile | null>(null);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<Category>('general');
  const [visibility, setVisibility] = useState<'org' | 'managers_only'>('managers_only');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handlePickFile() {
    const result = await DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true });
    if (result.canceled || result.assets.length === 0) return;
    const asset = result.assets[0];
    setFile({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType ?? null });
    if (!title.trim()) setTitle(asset.name.replace(/\.[^/.]+$/, '')); // default title from filename, sans extension
  }

  async function handleSubmit() {
    setErrorMessage(null);

    if (!session) return;
    if (!file) {
      setErrorMessage('Pick a file first.');
      return;
    }
    if (!title.trim()) {
      setErrorMessage('Enter a title.');
      return;
    }

    setSubmitting(true);

    const documentId = newId();
    // Sanitize the filename for the storage path — spaces and most
    // punctuation are technically legal in storage keys, but avoiding
    // them sidesteps URL-encoding edge cases entirely.
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${tourId}/${documentId}-${safeName}`;

    const { error: insertError } = await supabase.from('documents').insert({
      id: documentId,
      tour_id: tourId,
      uploaded_by: session.user.id,
      title: title.trim(),
      storage_path: storagePath,
      visibility,
      category,
    });
    if (insertError) {
      setSubmitting(false);
      setErrorMessage(insertError.message);
      return;
    }

    try {
      const response = await fetch(file.uri);
      const fileData = await response.arrayBuffer();
      const { error: uploadError } = await supabase.storage
        .from('tour-documents')
        .upload(storagePath, fileData, { contentType: file.mimeType ?? 'application/octet-stream' });

      if (uploadError) throw uploadError;
    } catch (err) {
      // Upload failed — don't leave a metadata row pointing at a file
      // that doesn't exist.
      await supabase.from('documents').delete().eq('id', documentId);
      setSubmitting(false);
      setErrorMessage(err instanceof Error ? err.message : 'Upload failed.');
      return;
    }

    setSubmitting(false);
    navigation.goBack();
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Upload Document</Text>

      <Pressable style={styles.filePicker} onPress={handlePickFile}>
        <Text style={styles.filePickerText}>{file ? file.name : 'Choose a file…'}</Text>
      </Pressable>

      <TextInput style={styles.input} placeholder="Title" placeholderTextColor="#6b6b76" value={title} onChangeText={setTitle} />

      <Text style={styles.sectionTitle}>Category</Text>
      <View style={styles.categoryRow}>
        {CATEGORIES.map((c) => (
          <Pressable
            key={c.value}
            style={[styles.categoryChip, category === c.value && styles.categoryChipActive]}
            onPress={() => setCategory(c.value)}
          >
            <Text style={[styles.categoryChipText, category === c.value && styles.categoryChipTextActive]}>{c.label}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.sectionTitle}>Who can see this</Text>
      <Pressable
        style={[styles.visibilityRow, visibility === 'managers_only' && styles.visibilityRowSelected]}
        onPress={() => setVisibility('managers_only')}
      >
        <Text style={styles.visibilityText}>Managers only</Text>
        {visibility === 'managers_only' && <Text style={styles.check}>✓</Text>}
      </Pressable>
      <Pressable
        style={[styles.visibilityRow, visibility === 'org' && styles.visibilityRowSelected]}
        onPress={() => setVisibility('org')}
      >
        <Text style={styles.visibilityText}>Everyone on the tour</Text>
        {visibility === 'org' && <Text style={styles.check}>✓</Text>}
      </Pressable>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <Pressable style={styles.submitButton} onPress={handleSubmit} disabled={submitting}>
        {submitting ? <ActivityIndicator color="#0b0b0f" /> : <Text style={styles.submitButtonText}>Upload</Text>}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b0f' },
  content: { padding: 20, paddingBottom: 60 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700', marginBottom: 16 },
  filePicker: {
    backgroundColor: '#1a1a20',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2a2a32',
    borderStyle: 'dashed',
    paddingVertical: 16,
    paddingHorizontal: 14,
    marginBottom: 10,
    alignItems: 'center',
  },
  filePickerText: { color: '#9a9aa5', fontSize: 14 },
  input: {
    backgroundColor: '#1a1a20',
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 10,
    fontSize: 15,
  },
  sectionTitle: { color: '#fff', fontSize: 14, fontWeight: '600', marginTop: 10, marginBottom: 8 },
  categoryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 6 },
  categoryChip: { backgroundColor: '#1a1a20', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 },
  categoryChipActive: { backgroundColor: '#fff' },
  categoryChipText: { color: '#9a9aa5', fontSize: 13, fontWeight: '600' },
  categoryChipTextActive: { color: '#0b0b0f' },
  visibilityRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: '#1a1a20',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 6,
  },
  visibilityRowSelected: { backgroundColor: '#2a2a3a' },
  visibilityText: { color: '#fff', fontSize: 14 },
  check: { color: '#7c9cff', fontSize: 14, fontWeight: '700' },
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