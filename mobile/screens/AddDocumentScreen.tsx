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
import { useEffect, useState } from 'react';
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
import { fetchTourRoster, type RosterMember } from '../lib/roster';
import { formatDepartment } from '../lib/format';
import { readFileAsBase64 } from '../lib/files';
import { logAuditEvent } from '../lib/auditLog';
import { notify } from '../lib/notify';
import type { RootStackParamList } from '../navigation/types';

type ArtistOption = { id: string; name: string };

// Matches the tour_department enum (0003, extended with 'security' in 0021).
const DEPARTMENTS = ['production', 'security', 'travel', 'artist_relations', 'finance', 'tour_management', 'general'];

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
  const [visibility, setVisibility] = useState<'org' | 'managers_only' | 'specific'>('managers_only');
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [selectedDepartments, setSelectedDepartments] = useState<Set<string>>(new Set());
  const [artists, setArtists] = useState<ArtistOption[]>([]);
  const [artistId, setArtistId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [suggestionHint, setSuggestionHint] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from('artists')
      .select('id, name')
      .eq('tour_id', tourId)
      .order('name', { ascending: true })
      .then(({ data }) => setArtists(data ?? []));
    fetchTourRoster(tourId)
      .then(setRoster)
      .catch(() => {});
  }, [tourId]);

  function toggleUser(userId: string) {
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  function toggleDepartment(department: string) {
    setSelectedDepartments((prev) => {
      const next = new Set(prev);
      if (next.has(department)) next.delete(department);
      else next.add(department);
      return next;
    });
  }

  async function handlePickFile() {
    const result = await DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true });
    if (result.canceled || result.assets.length === 0) return;
    const asset = result.assets[0];
    setFile({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType ?? null });
    setSuggestionHint(null);
    if (!title.trim()) setTitle(asset.name.replace(/\.[^/.]+$/, '')); // default title from filename, sans extension
  }

  // "AI drafts, human confirms" — every field this pre-fills stays in the
  // normal editable inputs below, nothing commits until Upload is
  // pressed. Deliberately never suggests visibility/sharing — who can
  // see a document is an access-control decision, not something to infer
  // from content.
  async function handleSuggestDetails() {
    if (!file) return;
    setErrorMessage(null);
    setSuggestionHint(null);
    setExtracting(true);
    try {
      const base64Data = await readFileAsBase64(file.uri);
      const { data, error } = await supabase.functions.invoke('extract-document-metadata', {
        body: { tourId, fileName: file.name, mimeType: file.mimeType ?? 'application/octet-stream', base64Data },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      if (data?.title) setTitle(data.title);
      if (data?.category && CATEGORIES.some((c) => c.value === data.category)) setCategory(data.category);

      if (data?.artist_name) {
        const match = artists.find((a) => a.name.toLowerCase() === String(data.artist_name).toLowerCase());
        if (match) {
          setArtistId(match.id);
          setSuggestionHint(`Details suggested — tagged to ${match.name}.`);
        } else {
          setSuggestionHint(`Details suggested — AI mentioned "${data.artist_name}", not in this tour's roster, tag manually if needed.`);
        }
      } else {
        setSuggestionHint('Details suggested.');
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not suggest details for this file.');
    } finally {
      setExtracting(false);
    }
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
    if (visibility === 'specific' && selectedUserIds.size === 0 && selectedDepartments.size === 0) {
      setErrorMessage('Pick at least one person or department, or choose a different visibility option.');
      return;
    }

    setSubmitting(true);

    const documentId = newId();
    // Sanitize the filename for the storage path — spaces and most
    // punctuation are technically legal in storage keys, but avoiding
    // them sidesteps URL-encoding edge cases entirely.
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${tourId}/${documentId}-${safeName}`;

    // "Specific people or departments" is an exception list layered on
    // top of the restrictive managers_only base (resource_shares, 0028)
    // — not a third value stored on the row itself. Same model already
    // used by schedule_items/checklists.
    const { error: insertError } = await supabase.from('documents').insert({
      id: documentId,
      tour_id: tourId,
      uploaded_by: session.user.id,
      title: title.trim(),
      storage_path: storagePath,
      visibility: visibility === 'specific' ? 'managers_only' : visibility,
      category,
      artist_id: artistId,
    });
    if (insertError) {
      setSubmitting(false);
      setErrorMessage(insertError.message);
      return;
    }

    if (visibility === 'specific') {
      const shareRows = [
        ...Array.from(selectedUserIds).map((userId) => ({
          tour_id: tourId,
          resource_type: 'document',
          resource_id: documentId,
          shared_with_user_id: userId,
          shared_with_department: null,
          permission: 'view' as const,
          granted_by: session.user.id,
        })),
        ...Array.from(selectedDepartments).map((department) => ({
          tour_id: tourId,
          resource_type: 'document',
          resource_id: documentId,
          shared_with_user_id: null,
          shared_with_department: department,
          permission: 'view' as const,
          granted_by: session.user.id,
        })),
      ];
      const { error: shareError } = await supabase.from('resource_shares').insert(shareRows);
      if (shareError) {
        setSubmitting(false);
        setErrorMessage(`Document uploaded, but sharing failed: ${shareError.message}`);
        return;
      }

      logAuditEvent({
        tourId,
        actorId: session.user.id,
        action: 'share',
        resourceType: 'resource_share',
        resourceId: documentId,
        detail: { resource_type: 'document', user_count: selectedUserIds.size, department_count: selectedDepartments.size },
      });

      // Notify specifically-shared people directly, plus everyone in a
      // shared department (resolved from the already-fetched roster).
      const departmentTargets = roster.filter((r) => selectedDepartments.has(r.department)).map((r) => r.user_id);
      const allTargets = Array.from(new Set([...selectedUserIds, ...departmentTargets]));
      notify({
        tourId,
        targetUserIds: allTargets,
        title: 'Document shared with you',
        body: title.trim(),
        data: { type: 'document_share', documentId },
      });
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

      {file && (
        <Pressable style={styles.suggestButton} onPress={handleSuggestDetails} disabled={extracting}>
          {extracting ? <ActivityIndicator color="#7c9cff" /> : <Text style={styles.suggestButtonText}>Suggest details ✨</Text>}
        </Pressable>
      )}
      {suggestionHint && <Text style={styles.suggestionHint}>{suggestionHint}</Text>}

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

      {artists.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>Tag to an artist (optional)</Text>
          <View style={styles.categoryRow}>
            <Pressable style={[styles.categoryChip, artistId === null && styles.categoryChipActive]} onPress={() => setArtistId(null)}>
              <Text style={[styles.categoryChipText, artistId === null && styles.categoryChipTextActive]}>None</Text>
            </Pressable>
            {artists.map((a) => (
              <Pressable key={a.id} style={[styles.categoryChip, artistId === a.id && styles.categoryChipActive]} onPress={() => setArtistId(a.id)}>
                <Text style={[styles.categoryChipText, artistId === a.id && styles.categoryChipTextActive]}>{a.name}</Text>
              </Pressable>
            ))}
          </View>
          {artistId && (
            <Text style={styles.artistTagHint}>
              {artists.find((a) => a.id === artistId)?.name}'s team will be able to see this, regardless of the visibility setting below.
            </Text>
          )}
        </>
      )}

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
      <Pressable
        style={[styles.visibilityRow, visibility === 'specific' && styles.visibilityRowSelected]}
        onPress={() => setVisibility('specific')}
      >
        <Text style={styles.visibilityText}>Specific people or departments</Text>
        {visibility === 'specific' && <Text style={styles.check}>✓</Text>}
      </Pressable>

      {visibility === 'specific' && (
        <View style={styles.shareBox}>
          <Text style={styles.shareBoxLabel}>Departments</Text>
          {DEPARTMENTS.map((d) => {
            const checked = selectedDepartments.has(d);
            return (
              <Pressable key={d} style={styles.checkboxRow} onPress={() => toggleDepartment(d)}>
                <View style={[styles.checkbox, checked && styles.checkboxChecked]}>{checked && <Text style={styles.checkmark}>✓</Text>}</View>
                <Text style={styles.checkboxLabel}>{formatDepartment(d)}</Text>
              </Pressable>
            );
          })}

          {roster.length > 0 && (
            <>
              <Text style={[styles.shareBoxLabel, styles.shareBoxLabelSpaced]}>People</Text>
              {roster.map((member) => {
                const checked = selectedUserIds.has(member.user_id);
                return (
                  <Pressable key={member.user_id} style={styles.checkboxRow} onPress={() => toggleUser(member.user_id)}>
                    <View style={[styles.checkbox, checked && styles.checkboxChecked]}>{checked && <Text style={styles.checkmark}>✓</Text>}</View>
                    <Text style={styles.checkboxLabel}>{member.display_name}</Text>
                  </Pressable>
                );
              })}
            </>
          )}
        </View>
      )}

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
  suggestButton: {
    backgroundColor: '#15151a',
    borderWidth: 1,
    borderColor: '#2a2a32',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    marginBottom: 6,
  },
  suggestButtonText: { color: '#7c9cff', fontSize: 13, fontWeight: '600' },
  suggestionHint: { color: '#6b6b76', fontSize: 12, marginBottom: 10 },
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
  artistTagHint: { color: '#6b6b76', fontSize: 12, marginTop: -2, marginBottom: 8 },
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
  shareBox: { backgroundColor: '#15151a', borderRadius: 10, padding: 14, marginBottom: 6 },
  shareBoxLabel: { color: '#9a9aa5', fontSize: 11, fontWeight: '600', textTransform: 'uppercase', marginBottom: 8 },
  shareBoxLabelSpaced: { marginTop: 14 },
  checkboxRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: '#6b6b76',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  checkboxChecked: { backgroundColor: '#7c9cff', borderColor: '#7c9cff' },
  checkmark: { color: '#0b0b0f', fontSize: 12, fontWeight: '700' },
  checkboxLabel: { color: '#fff', fontSize: 14 },
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