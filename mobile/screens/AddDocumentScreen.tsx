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
 *
 * Theme (Manrope/JetBrains Mono, navy accent) per the "Load-In" design
 * review — see lib/theme.tsx.
 */
import { useEffect, useMemo, useState } from 'react';
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
import { getInvokeErrorMessage } from '../lib/functionError';
import { fetchTourRoster, type RosterMember } from '../lib/roster';
import { formatDepartment } from '../lib/format';
import { readFileAsBase64 } from '../lib/files';
import { logAuditEvent } from '../lib/auditLog';
import { notify } from '../lib/notify';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
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
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

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
      if (error || data?.error) throw new Error(await getInvokeErrorMessage(error, data, 'Extraction failed.'));

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
          {extracting ? <ActivityIndicator color={colors.accent} /> : <Text style={styles.suggestButtonText}>Suggest details ✨</Text>}
        </Pressable>
      )}
      {suggestionHint && <Text style={styles.suggestionHint}>{suggestionHint}</Text>}

      <TextInput style={styles.input} placeholder="Title" placeholderTextColor={colors.textFaint} value={title} onChangeText={setTitle} />

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
        {submitting ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.submitButtonText}>Upload</Text>}
      </Pressable>
    </ScrollView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    content: { padding: 20, paddingBottom: 60 },
    title: { color: colors.text, fontSize: 22, fontFamily: fonts.displayBold, marginBottom: 16 },
    filePicker: {
      backgroundColor: colors.surface,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      borderStyle: 'dashed',
      paddingVertical: 16,
      paddingHorizontal: 14,
      marginBottom: 10,
      alignItems: 'center',
    },
    filePickerText: { color: colors.textDim, fontSize: 14, fontFamily: fonts.body },
    suggestButton: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingVertical: 10,
      alignItems: 'center',
      marginBottom: 6,
    },
    suggestButtonText: { color: colors.accent, fontSize: 13, fontFamily: fonts.bodySemiBold },
    suggestionHint: { color: colors.textFaint, fontSize: 12, marginBottom: 10, fontFamily: fonts.body },
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
    sectionTitle: { color: colors.text, fontSize: 14, fontFamily: fonts.bodySemiBold, marginTop: 10, marginBottom: 8 },
    categoryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 6 },
    categoryChip: { backgroundColor: colors.surface2, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 },
    categoryChipActive: { backgroundColor: colors.accent },
    categoryChipText: { color: colors.textDim, fontSize: 13, fontFamily: fonts.bodySemiBold },
    categoryChipTextActive: { color: colors.onAccent },
    artistTagHint: { color: colors.textFaint, fontSize: 12, marginTop: -2, marginBottom: 8, fontFamily: fonts.body },
    visibilityRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      backgroundColor: colors.surface,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 10,
      marginBottom: 6,
      borderWidth: 1,
      borderColor: colors.border,
    },
    visibilityRowSelected: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
    visibilityText: { color: colors.text, fontSize: 14, fontFamily: fonts.body },
    check: { color: colors.accent, fontSize: 14, fontFamily: fonts.bodyBold },
    shareBox: { backgroundColor: colors.surface2, borderRadius: 10, padding: 14, marginBottom: 6 },
    shareBoxLabel: { color: colors.textDim, fontSize: 11, fontFamily: fonts.bodySemiBold, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
    shareBoxLabelSpaced: { marginTop: 14 },
    checkboxRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
    checkbox: {
      width: 20,
      height: 20,
      borderRadius: 5,
      borderWidth: 2,
      borderColor: colors.textFaint,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 10,
    },
    checkboxChecked: { backgroundColor: colors.accent, borderColor: colors.accent },
    checkmark: { color: colors.onAccent, fontSize: 12, fontFamily: fonts.bodyBold },
    checkboxLabel: { color: colors.text, fontSize: 14, fontFamily: fonts.body },
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
