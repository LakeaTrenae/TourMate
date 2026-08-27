/**
 * SettingsScreen — profile editing (name, phone, avatar), a read-only
 * list of the organizations you belong to, sign out, and account
 * deletion.
 *
 * Account deletion exists because Apple requires it: any app that lets
 * someone create an account must let them delete it from inside the app,
 * or App Store review rejects the submission. The actual deletion runs
 * server-side (supabase/functions/delete-account) — this screen is just
 * the confirmation UI and the call site.
 */
import { useCallback, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

type OrgMembership = { organization_id: string; role: string; organization: { name: string } | null };

export function SettingsScreen({ navigation }: Props) {
  const { session, profile, refreshProfile, signOut } = useAuth();

  const [preferredName, setPreferredName] = useState(profile?.preferred_name ?? '');
  const [phone, setPhone] = useState(profile?.phone ?? '');
  const [orgs, setOrgs] = useState<OrgMembership[]>([]);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      supabase
        .from('organization_members')
        .select('organization_id, role, organization:organizations(name)')
        .then(({ data, error }) => {
          if (error) setErrorMessage(error.message);
          else setOrgs((data ?? []) as unknown as OrgMembership[]);
        });
    }, [])
  );

  async function handlePickAvatar() {
    setErrorMessage(null);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setErrorMessage('Photo library access is needed to set a profile picture.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.7,
      allowsEditing: true,
      aspect: [1, 1],
    });
    if (result.canceled || result.assets.length === 0) return;
    const asset = result.assets[0];
    if (!session) return;

    setUploadingAvatar(true);
    try {
      const response = await fetch(asset.uri);
      const fileData = await response.arrayBuffer();
      const path = `${session.user.id}/avatar`;
      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(path, fileData, { contentType: asset.mimeType ?? 'image/jpeg', upsert: true });
      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage.from('avatars').getPublicUrl(path);
      // Cache-bust — the path never changes across uploads, so without a
      // query param the old image would keep showing from cache after a
      // new one is set.
      const avatarUrl = `${urlData.publicUrl}?t=${Date.now()}`;

      const { error: updateError } = await supabase.from('profiles').update({ avatar_url: avatarUrl }).eq('id', session.user.id);
      if (updateError) throw updateError;

      await refreshProfile();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to update photo.');
    } finally {
      setUploadingAvatar(false);
    }
  }

  async function handleSaveProfile() {
    setErrorMessage(null);
    if (!session) return;
    setSavingProfile(true);
    const { error } = await supabase
      .from('profiles')
      .update({ preferred_name: preferredName.trim(), phone: phone.trim() || null })
      .eq('id', session.user.id);
    setSavingProfile(false);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    await refreshProfile();
  }

  function confirmDeleteAccount() {
    Alert.alert(
      'Delete your account?',
      "This permanently deletes your account and profile. Tours, documents, and other records you created stay in place for your team, but your name is removed from them. This can't be undone.",
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete Account', style: 'destructive', onPress: handleDeleteAccount },
      ]
    );
  }

  async function handleDeleteAccount() {
    setErrorMessage(null);
    setDeleting(true);
    const { data, error } = await supabase.functions.invoke('delete-account');
    setDeleting(false);

    if (error || data?.error) {
      setErrorMessage(data?.error ?? error?.message ?? 'Failed to delete account.');
      return;
    }
    // The account is gone server-side; clear the local session so
    // RootNavigator drops back to the sign-in screen.
    await signOut();
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Settings</Text>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <View style={styles.avatarSection}>
        <Pressable onPress={handlePickAvatar} disabled={uploadingAvatar}>
          {profile?.avatar_url ? (
            <Image source={{ uri: profile.avatar_url }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarPlaceholder]}>
              <Text style={styles.avatarPlaceholderText}>{profile?.display_name?.charAt(0)?.toUpperCase() ?? '?'}</Text>
            </View>
          )}
          {uploadingAvatar && (
            <View style={styles.avatarOverlay}>
              <ActivityIndicator color="#fff" />
            </View>
          )}
        </Pressable>
        <Pressable onPress={handlePickAvatar} disabled={uploadingAvatar}>
          <Text style={styles.changePhotoText}>Change photo</Text>
        </Pressable>
      </View>

      <Text style={styles.sectionTitle}>Profile</Text>
      <TextInput
        style={styles.input}
        placeholder="Preferred name"
        placeholderTextColor="#6b6b76"
        value={preferredName}
        onChangeText={setPreferredName}
        autoCapitalize="words"
      />
      <TextInput
        style={styles.input}
        placeholder="Phone"
        placeholderTextColor="#6b6b76"
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
      />
      <View style={styles.readOnlyRow}>
        <Text style={styles.readOnlyLabel}>Email</Text>
        <Text style={styles.readOnlyValue}>{profile?.email}</Text>
      </View>
      <View style={styles.readOnlyRow}>
        <Text style={styles.readOnlyLabel}>Legal name</Text>
        <Text style={styles.readOnlyValue}>{profile?.full_name}</Text>
      </View>

      <Pressable style={styles.saveButton} onPress={handleSaveProfile} disabled={savingProfile}>
        {savingProfile ? <ActivityIndicator color="#0b0b0f" /> : <Text style={styles.saveButtonText}>Save Profile</Text>}
      </Pressable>

      <Text style={[styles.sectionTitle, styles.sectionTitleSpaced]}>Organizations</Text>
      {orgs.length === 0 && <Text style={styles.emptyText}>Not part of any organization yet.</Text>}
      {orgs.map((o) => (
        <Pressable
          key={o.organization_id}
          style={styles.orgRow}
          onPress={() =>
            navigation.navigate('Venues', {
              organizationId: o.organization_id,
              organizationName: o.organization?.name ?? 'Venues',
            })
          }
        >
          <View>
            <Text style={styles.orgName}>{o.organization?.name ?? 'Unknown'}</Text>
            <Text style={styles.orgRole}>{o.role.charAt(0).toUpperCase() + o.role.slice(1)}</Text>
          </View>
          <Text style={styles.orgAction}>Venues ›</Text>
        </Pressable>
      ))}

      <Text style={[styles.sectionTitle, styles.sectionTitleSpaced]}>Travel Documents</Text>
      <Pressable style={styles.travelDocsRow} onPress={() => navigation.navigate('PassportVisa', {})}>
        <Text style={styles.travelDocsText}>Passport & Visa</Text>
        <Text style={styles.orgAction}>›</Text>
      </Pressable>

      <Pressable style={styles.signOutButton} onPress={signOut}>
        <Text style={styles.signOutButtonText}>Sign Out</Text>
      </Pressable>

      <View style={styles.dangerZone}>
        <Text style={styles.dangerTitle}>Danger Zone</Text>
        <Pressable style={styles.deleteButton} onPress={confirmDeleteAccount} disabled={deleting}>
          {deleting ? <ActivityIndicator color="#ff6b6b" /> : <Text style={styles.deleteButtonText}>Delete Account</Text>}
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b0f' },
  content: { padding: 20, paddingBottom: 60 },
  title: { color: '#fff', fontSize: 24, fontWeight: '700', marginBottom: 16 },
  error: { color: '#ff6b6b', fontSize: 13, marginBottom: 12 },
  avatarSection: { alignItems: 'center', marginBottom: 24 },
  avatar: { width: 88, height: 88, borderRadius: 44, backgroundColor: '#1a1a20' },
  avatarPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  avatarPlaceholderText: { color: '#6b6b76', fontSize: 32, fontWeight: '700' },
  avatarOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 44,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  changePhotoText: { color: '#7c9cff', fontSize: 13, fontWeight: '600', marginTop: 10, textAlign: 'center' },
  sectionTitle: { color: '#9a9aa5', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', marginBottom: 8 },
  sectionTitleSpaced: { marginTop: 24 },
  input: {
    backgroundColor: '#1a1a20',
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 10,
    fontSize: 15,
  },
  readOnlyRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8 },
  readOnlyLabel: { color: '#6b6b76', fontSize: 13 },
  readOnlyValue: { color: '#9a9aa5', fontSize: 13 },
  saveButton: { backgroundColor: '#fff', borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 12 },
  saveButtonText: { color: '#0b0b0f', fontSize: 15, fontWeight: '600' },
  emptyText: { color: '#6b6b76', fontSize: 13 },
  orgRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#1a1a20',
    borderRadius: 10,
    padding: 12,
    marginBottom: 6,
  },
  orgName: { color: '#fff', fontSize: 14 },
  orgRole: { color: '#6b6b76', fontSize: 12 },
  orgAction: { color: '#7c9cff', fontSize: 13, fontWeight: '600' },
  travelDocsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#1a1a20',
    borderRadius: 10,
    padding: 12,
  },
  travelDocsText: { color: '#fff', fontSize: 14 },
  signOutButton: { alignItems: 'center', paddingVertical: 14, marginTop: 28 },
  signOutButtonText: { color: '#9a9aa5', fontSize: 15, fontWeight: '600' },
  dangerZone: { marginTop: 20, borderTopWidth: 1, borderTopColor: '#2a2a32', paddingTop: 20 },
  dangerTitle: { color: '#6b6b76', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', marginBottom: 10 },
  deleteButton: { alignItems: 'center', paddingVertical: 12 },
  deleteButtonText: { color: '#ff6b6b', fontSize: 14, fontWeight: '600' },
});