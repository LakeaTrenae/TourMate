/**
 * TourSettingsScreen — rename, complete/reopen, or delete a tour.
 *
 * Mirrors the server-side permission tiers exactly rather than inventing
 * its own: renaming and marking complete use the same "tours updatable by
 * managers" RLS policy (0001_init.sql) every other manager-tier write
 * goes through; reopening a completed tour and deleting it outright are
 * both reserved for the tour's actual owner, matching
 * is_tour_owner()/the completion-lock trigger's override tier
 * (0005_tour_completion_lock.sql) and the new owner-only delete policy
 * (0043_tour_delete.sql — tours never had a delete policy before this).
 * effective_tour_role is fetched fresh via RPC rather than trusted from a
 * nav param, so what this screen offers can never drift from what the
 * database will actually allow.
 */
import { useCallback, useMemo, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';

import { supabase } from '../lib/supabase';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'TourSettings'>;

export function TourSettingsScreen({ route, navigation }: Props) {
  const { tourId, tourName } = route.params;
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [loading, setLoading] = useState(true);
  const [effectiveRole, setEffectiveRole] = useState<string | null>(null);
  const [completedAt, setCompletedAt] = useState<string | null>(null);
  const [name, setName] = useState(tourName);
  const [coverPhotoPath, setCoverPhotoPath] = useState<string | null>(null);
  const [coverPhotoUrl, setCoverPhotoUrl] = useState<string | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [saving, setSaving] = useState(false);
  const [togglingComplete, setTogglingComplete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id;
    if (!userId) return;

    const [{ data: roleData, error: roleError }, { data: tourData, error: tourError }] = await Promise.all([
      supabase.rpc('effective_tour_role', { p_tour_id: tourId, p_user_id: userId }),
      supabase.from('tours').select('name, completed_at, cover_photo_path').eq('id', tourId).single(),
    ]);
    if (roleError) throw roleError;
    if (tourError) throw tourError;

    setEffectiveRole(roleData ?? null);
    setCompletedAt(tourData?.completed_at ?? null);
    setName(tourData?.name ?? tourName);
    setCoverPhotoPath(tourData?.cover_photo_path ?? null);

    if (tourData?.cover_photo_path) {
      const { data: signed } = await supabase.storage.from('tour-covers').createSignedUrl(tourData.cover_photo_path, 3600);
      setCoverPhotoUrl(signed?.signedUrl ?? null);
    } else {
      setCoverPhotoUrl(null);
    }
  }, [tourId, tourName]);

  async function handlePickCoverPhoto() {
    setErrorMessage(null);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setErrorMessage('Photo library access is needed to set a cover photo.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.7,
      allowsEditing: true,
      aspect: [16, 9],
    });
    if (result.canceled || result.assets.length === 0) return;
    const asset = result.assets[0];

    setUploadingPhoto(true);
    try {
      const response = await fetch(asset.uri);
      const fileData = await response.arrayBuffer();
      const path = `${tourId}/cover`;
      const { error: uploadError } = await supabase.storage
        .from('tour-covers')
        .upload(path, fileData, { contentType: asset.mimeType ?? 'image/jpeg', upsert: true });
      if (uploadError) throw uploadError;

      const { error: updateError } = await supabase.from('tours').update({ cover_photo_path: path }).eq('id', tourId);
      if (updateError) throw updateError;

      await load();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to upload cover photo.');
    } finally {
      setUploadingPhoto(false);
    }
  }

  async function handleRemoveCoverPhoto() {
    if (!coverPhotoPath) return;
    setErrorMessage(null);
    setUploadingPhoto(true);
    try {
      const { error: updateError } = await supabase.from('tours').update({ cover_photo_path: null }).eq('id', tourId);
      if (updateError) throw updateError;
      await supabase.storage.from('tour-covers').remove([coverPhotoPath]);
      await load();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to remove cover photo.');
    } finally {
      setUploadingPhoto(false);
    }
  }

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load()
        .catch((err) => setErrorMessage(err instanceof Error ? err.message : 'Failed to load tour settings.'))
        .finally(() => setLoading(false));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tourId])
  );

  const isManager = effectiveRole === 'owner' || effectiveRole === 'admin' || effectiveRole === 'manager';
  const isOwner = effectiveRole === 'owner';
  const nameChanged = name.trim().length > 0 && name.trim() !== tourName;

  async function handleRename() {
    if (!nameChanged) return;
    setErrorMessage(null);
    setSaving(true);
    const trimmed = name.trim();
    const { error } = await supabase.from('tours').update({ name: trimmed }).eq('id', tourId);
    setSaving(false);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    navigation.navigate('TourDashboard', { tourId, tourName: trimmed });
  }

  async function handleToggleComplete() {
    setErrorMessage(null);
    setTogglingComplete(true);
    const { error } = await supabase
      .from('tours')
      .update({ completed_at: completedAt ? null : new Date().toISOString() })
      .eq('id', tourId);
    setTogglingComplete(false);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    await load();
  }

  function confirmDelete() {
    Alert.alert(
      `Delete "${tourName}"?`,
      'This permanently deletes the entire tour — schedule, budget, lodging, travel, guest list, and documents. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete Tour', style: 'destructive', onPress: handleDelete },
      ]
    );
  }

  async function handleDelete() {
    setErrorMessage(null);
    setDeleting(true);
    const { error } = await supabase.from('tours').delete().eq('id', tourId);
    setDeleting(false);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    navigation.navigate('TourList');
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Tour Settings</Text>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      {!isManager && <Text style={styles.readOnlyHint}>You don't have manager access on this tour.</Text>}

      {isManager && (
        <>
          <Text style={styles.sectionTitle}>Cover Photo</Text>
          {coverPhotoUrl && <Image source={{ uri: coverPhotoUrl }} style={styles.coverPreview} />}
          <View style={styles.coverButtonRow}>
            <Pressable style={[styles.secondaryButton, styles.coverPickButton]} onPress={handlePickCoverPhoto} disabled={uploadingPhoto}>
              {uploadingPhoto ? (
                <ActivityIndicator color={colors.accent} />
              ) : (
                <Text style={styles.secondaryButtonText}>{coverPhotoUrl ? 'Change Photo' : 'Add Photo'}</Text>
              )}
            </Pressable>
            {coverPhotoUrl && (
              <Pressable style={styles.coverRemoveButton} onPress={handleRemoveCoverPhoto} disabled={uploadingPhoto}>
                <Text style={styles.coverRemoveButtonText}>Remove</Text>
              </Pressable>
            )}
          </View>

          <Text style={styles.sectionTitle}>Name</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Tour name"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="words"
          />
          <Pressable
            style={[styles.saveButton, !nameChanged && styles.saveButtonDisabled]}
            onPress={handleRename}
            disabled={!nameChanged || saving}
          >
            {saving ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.saveButtonText}>Save Name</Text>}
          </Pressable>

          <Text style={styles.sectionTitle}>Status</Text>
          {completedAt ? (
            <>
              <Text style={styles.statusText}>
                Completed on{' '}
                {new Date(completedAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}
              </Text>
              {isOwner ? (
                <Pressable style={styles.secondaryButton} onPress={handleToggleComplete} disabled={togglingComplete}>
                  {togglingComplete ? (
                    <ActivityIndicator color={colors.accent} />
                  ) : (
                    <Text style={styles.secondaryButtonText}>Reopen Tour</Text>
                  )}
                </Pressable>
              ) : (
                <Text style={styles.readOnlyHint}>Only the tour owner can reopen a completed tour.</Text>
              )}
            </>
          ) : (
            <Pressable style={styles.secondaryButton} onPress={handleToggleComplete} disabled={togglingComplete}>
              {togglingComplete ? (
                <ActivityIndicator color={colors.accent} />
              ) : (
                <Text style={styles.secondaryButtonText}>Mark as Completed</Text>
              )}
            </Pressable>
          )}
        </>
      )}

      {isOwner && (
        <>
          <Text style={styles.dangerSectionTitle}>Danger Zone</Text>
          <Pressable style={styles.deleteButton} onPress={confirmDelete} disabled={deleting}>
            {deleting ? <ActivityIndicator color={colors.danger} /> : <Text style={styles.deleteButtonText}>Delete Tour</Text>}
          </Pressable>
          <Text style={styles.dangerHint}>Permanently deletes everything on this tour. Cannot be undone.</Text>
        </>
      )}
    </ScrollView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    centered: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
    content: { padding: 20, paddingBottom: 60 },
    title: { color: colors.text, fontSize: 29, fontFamily: fonts.displayBlack, marginBottom: 16 },
    error: { color: colors.danger, fontSize: 16, marginBottom: 12, fontFamily: fonts.body },
    readOnlyHint: { color: colors.textDim, fontSize: 16, lineHeight: 18, fontFamily: fonts.body },
    sectionTitle: {
      color: colors.textDim,
      fontSize: 15,
      fontFamily: fonts.bodySemiBold,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginTop: 24,
      marginBottom: 8,
    },
    input: {
      backgroundColor: colors.surface,
      color: colors.text,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 19,
      fontFamily: fonts.body,
      marginBottom: 10,
      borderWidth: 1,
      borderColor: colors.border,
    },
    coverPreview: { width: '100%', height: 140, borderRadius: 12, marginBottom: 10, backgroundColor: colors.surface2 },
    coverButtonRow: { flexDirection: 'row', gap: 8 },
    coverPickButton: { flex: 1 },
    coverRemoveButton: {
      borderWidth: 1,
      borderColor: colors.danger,
      borderRadius: 10,
      paddingVertical: 12,
      paddingHorizontal: 16,
      alignItems: 'center',
    },
    coverRemoveButtonText: { color: colors.danger, fontSize: 17, fontFamily: fonts.bodySemiBold },
    saveButton: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
    saveButtonDisabled: { opacity: 0.5 },
    saveButtonText: { color: colors.onAccent, fontSize: 17, fontFamily: fonts.bodySemiBold },
    statusText: { color: colors.text, fontSize: 17, fontFamily: fonts.body, marginBottom: 10 },
    secondaryButton: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingVertical: 12,
      alignItems: 'center',
    },
    secondaryButtonText: { color: colors.accent, fontSize: 17, fontFamily: fonts.bodySemiBold },
    dangerSectionTitle: {
      color: colors.danger,
      fontSize: 15,
      fontFamily: fonts.bodySemiBold,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginTop: 32,
      marginBottom: 8,
    },
    deleteButton: {
      borderWidth: 1,
      borderColor: colors.danger,
      borderRadius: 10,
      paddingVertical: 12,
      alignItems: 'center',
    },
    deleteButtonText: { color: colors.danger, fontSize: 17, fontFamily: fonts.bodySemiBold },
    dangerHint: { color: colors.textFaint, fontSize: 15, marginTop: 8, lineHeight: 16, fontFamily: fonts.body },
  });
}
