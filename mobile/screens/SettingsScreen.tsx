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
 *
 * Theme (Manrope/JetBrains Mono, navy accent) per the "Load-In" design
 * review — see lib/theme.tsx. This screen also owns the Appearance
 * section (System/Light/Dark) that drives useTheme() for the rest of the
 * converted screens.
 */
import { useCallback, useMemo, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { supabase, functionsUrl } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { registerForPushNotifications } from '../lib/pushNotifications';
import { getInvokeErrorMessage } from '../lib/functionError';
import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from '../lib/legal';
import { useTheme, fonts, type ThemeColors, type ThemePreference } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

type OrgMembership = { organization_id: string; role: string; organization: { name: string } | null };
type EnrollData = { factorId: string; secret: string; uri: string };

export function SettingsScreen({ navigation }: Props) {
  const { session, profile, refreshProfile, signOut, refreshMfaStatus } = useAuth();
  const { colors, preference, setPreference } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [preferredName, setPreferredName] = useState(profile?.preferred_name ?? '');
  const [phone, setPhone] = useState(profile?.phone ?? '');
  const [orgs, setOrgs] = useState<OrgMembership[]>([]);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [registeringPush, setRegisteringPush] = useState(false);
  const [pushStatus, setPushStatus] = useState<string | null>(null);
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [mfaFactorId, setMfaFactorId] = useState<string | null>(null);
  const [enrollData, setEnrollData] = useState<EnrollData | null>(null);
  const [enrollCode, setEnrollCode] = useState('');
  const [mfaBusy, setMfaBusy] = useState(false);
  const [mfaStatus, setMfaStatus] = useState<string | null>(null);
  const [calendarFeedToken, setCalendarFeedToken] = useState<string | null>(null);
  const [tripitFeedUrl, setTripitFeedUrl] = useState('');
  const [savedTripitFeedUrl, setSavedTripitFeedUrl] = useState('');
  const [savingTripit, setSavingTripit] = useState(false);
  const [rotatingToken, setRotatingToken] = useState(false);
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
      loadMfaFactors();
      if (session) {
        supabase
          .from('profiles')
          .select('calendar_feed_token, tripit_feed_url')
          .eq('id', session.user.id)
          .single()
          .then(({ data }) => {
            setCalendarFeedToken(data?.calendar_feed_token ?? null);
            setTripitFeedUrl(data?.tripit_feed_url ?? '');
            setSavedTripitFeedUrl(data?.tripit_feed_url ?? '');
          });
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [session])
  );

  // webcal:// (not https://) is what tells iOS/Android/desktop calendar
  // apps to treat this as a live subscription to add, rather than a file
  // to download — same URL, different scheme, same one-time-not-live
  // distinction TourExportScreen's plain .ics share can't offer.
  function handleSubscribeCalendar() {
    if (!calendarFeedToken) return;
    const feedUrl = functionsUrl('calendar-feed').replace(/^https?:\/\//, 'webcal://');
    Linking.openURL(`${feedUrl}?token=${calendarFeedToken}`);
  }

  function confirmRotateToken() {
    Alert.alert(
      'Rotate your calendar feed link?',
      'Your current subscription will stop updating — resubscribe with the new link afterward.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Rotate', style: 'destructive', onPress: handleRotateToken },
      ]
    );
  }

  async function handleRotateToken() {
    setRotatingToken(true);
    const { data, error } = await supabase.rpc('rotate_my_calendar_feed_token');
    setRotatingToken(false);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    setCalendarFeedToken(data);
  }

  async function handleSaveTripitUrl() {
    if (!session) return;
    setSavingTripit(true);
    const { error } = await supabase.from('profiles').update({ tripit_feed_url: tripitFeedUrl.trim() || null }).eq('id', session.user.id);
    setSavingTripit(false);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    setSavedTripitFeedUrl(tripitFeedUrl);
  }

  async function loadMfaFactors() {
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error) return;
    const verified = data?.totp.find((f) => f.status === 'verified');
    setMfaEnabled(!!verified);
    setMfaFactorId(verified?.id ?? null);
  }

  // Two calls, in order: enroll() creates an *unverified* factor and
  // hands back the secret/QR-equivalent URI (shown as raw text — no QR
  // library in this app yet); it only counts as "on" once a code from it
  // is actually verified below, same as any authenticator-app setup flow.
  async function handleStartEnroll() {
    setErrorMessage(null);
    setMfaStatus(null);
    setMfaBusy(true);
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
    setMfaBusy(false);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    setEnrollData({ factorId: data.id, secret: data.totp.secret, uri: data.totp.uri });
    setEnrollCode('');
  }

  async function handleConfirmEnroll() {
    if (!enrollData) return;
    setErrorMessage(null);
    if (enrollCode.trim().length !== 6) {
      setErrorMessage('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setMfaBusy(true);
    const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({ factorId: enrollData.factorId });
    if (challengeError) {
      setMfaBusy(false);
      setErrorMessage(challengeError.message);
      return;
    }
    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId: enrollData.factorId,
      challengeId: challengeData.id,
      code: enrollCode.trim(),
    });
    setMfaBusy(false);
    if (verifyError) {
      setErrorMessage(verifyError.message);
      return;
    }
    setEnrollData(null);
    setEnrollCode('');
    setMfaStatus('Two-factor authentication is on.');
    await loadMfaFactors();
    await refreshMfaStatus();
  }

  function cancelEnroll() {
    // Best-effort cleanup of the unverified factor so it doesn't linger —
    // failure here is harmless (an unverified factor never gates
    // anything), so it isn't surfaced as an error.
    if (enrollData) supabase.auth.mfa.unenroll({ factorId: enrollData.factorId }).catch(() => {});
    setEnrollData(null);
    setEnrollCode('');
  }

  function confirmDisableMfa() {
    if (!mfaFactorId) return;
    Alert.alert('Turn off two-factor authentication?', "You'll only need your password to sign in.", [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Turn Off', style: 'destructive', onPress: handleDisableMfa },
    ]);
  }

  async function handleDisableMfa() {
    if (!mfaFactorId) return;
    setErrorMessage(null);
    setMfaBusy(true);
    const { error } = await supabase.auth.mfa.unenroll({ factorId: mfaFactorId });
    setMfaBusy(false);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    setMfaStatus('Two-factor authentication is off.');
    await loadMfaFactors();
    await refreshMfaStatus();
  }

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

  async function handleEnablePush() {
    if (!session) return;
    setErrorMessage(null);
    setPushStatus(null);
    setRegisteringPush(true);
    const { error } = await registerForPushNotifications(session.user.id);
    setRegisteringPush(false);
    setPushStatus(error ? null : 'Push notifications are on for this device.');
    if (error) setErrorMessage(error);
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
      setErrorMessage(await getInvokeErrorMessage(error, data, 'Failed to delete account.'));
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
              <ActivityIndicator color={colors.text} />
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
        placeholderTextColor={colors.textFaint}
        value={preferredName}
        onChangeText={setPreferredName}
        autoCapitalize="words"
      />
      <TextInput
        style={styles.input}
        placeholder="Phone"
        placeholderTextColor={colors.textFaint}
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
        {savingProfile ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.saveButtonText}>Save Profile</Text>}
      </Pressable>

      <Text style={[styles.sectionTitle, styles.sectionTitleSpaced]}>Billing</Text>
      <Pressable style={styles.travelDocsRow} onPress={() => navigation.navigate('Billing')}>
        <Text style={styles.travelDocsText}>Subscription</Text>
        <Text style={styles.orgAction}>›</Text>
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
      <Pressable style={styles.travelDocsRow} onPress={() => navigation.navigate('EmergencyContact', {})}>
        <Text style={styles.travelDocsText}>Emergency Contact</Text>
        <Text style={styles.orgAction}>›</Text>
      </Pressable>

      <Text style={[styles.sectionTitle, styles.sectionTitleSpaced]}>Notifications</Text>
      <Pressable style={styles.travelDocsRow} onPress={handleEnablePush} disabled={registeringPush}>
        {registeringPush ? (
          <ActivityIndicator color={colors.text} />
        ) : (
          <Text style={styles.travelDocsText}>Enable Push Notifications</Text>
        )}
      </Pressable>
      {pushStatus && <Text style={styles.pushStatus}>{pushStatus}</Text>}

      <Text style={[styles.sectionTitle, styles.sectionTitleSpaced]}>Calendar & Travel Import</Text>
      <Pressable style={styles.travelDocsRow} onPress={handleSubscribeCalendar} disabled={!calendarFeedToken}>
        <Text style={styles.travelDocsText}>Subscribe to Calendar</Text>
        <Text style={styles.orgAction}>›</Text>
      </Pressable>
      <Text style={styles.notesHint}>
        Adds a live calendar feed of every show you're on — stays synced automatically, unlike a one-time export.
      </Text>
      <Pressable onPress={confirmRotateToken} disabled={rotatingToken}>
        {rotatingToken ? <ActivityIndicator color={colors.textDim} /> : <Text style={styles.rotateLink}>Rotate calendar link</Text>}
      </Pressable>

      <Text style={[styles.notesHint, styles.tripitLabel]}>
        TripIt feed URL (from TripIt's "Sync to Calendar" settings) — lets TourMate import your flights and lodging.
      </Text>
      <View style={styles.inputRow}>
        <TextInput
          style={[styles.input, styles.rowInput]}
          placeholder="webcal://www.tripit.com/feed/ical/private/..."
          placeholderTextColor={colors.textFaint}
          value={tripitFeedUrl}
          onChangeText={setTripitFeedUrl}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {tripitFeedUrl !== savedTripitFeedUrl && (
          <Pressable style={styles.tripitSaveButton} onPress={handleSaveTripitUrl} disabled={savingTripit}>
            {savingTripit ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.tripitSaveButtonText}>Save</Text>}
          </Pressable>
        )}
      </View>

      <Text style={[styles.sectionTitle, styles.sectionTitleSpaced]}>Security</Text>
      {mfaStatus && <Text style={styles.pushStatus}>{mfaStatus}</Text>}

      {enrollData ? (
        <View style={styles.mfaSetupBox}>
          <Text style={styles.mfaSetupLabel}>Scan or enter this manually in your authenticator app</Text>
          <Text style={styles.mfaSecret} selectable>
            {enrollData.secret}
          </Text>
          <Text style={styles.mfaUri} selectable>
            {enrollData.uri}
          </Text>
          <TextInput
            style={styles.input}
            placeholder="Enter the 6-digit code to confirm"
            placeholderTextColor={colors.textFaint}
            value={enrollCode}
            onChangeText={setEnrollCode}
            keyboardType="number-pad"
            maxLength={6}
          />
          <View style={styles.mfaSetupActions}>
            <Pressable style={[styles.saveButton, styles.mfaConfirmButton]} onPress={handleConfirmEnroll} disabled={mfaBusy}>
              {mfaBusy ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.saveButtonText}>Confirm</Text>}
            </Pressable>
            <Pressable style={styles.cancelEnrollButton} onPress={cancelEnroll} disabled={mfaBusy}>
              <Text style={styles.cancelEnrollButtonText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : mfaEnabled ? (
        <View style={styles.travelDocsRow}>
          <Text style={styles.travelDocsText}>Two-factor authentication is on</Text>
          <Pressable onPress={confirmDisableMfa} disabled={mfaBusy}>
            {mfaBusy ? <ActivityIndicator color={colors.danger} /> : <Text style={styles.mfaDisableText}>Turn off</Text>}
          </Pressable>
        </View>
      ) : (
        <Pressable style={styles.travelDocsRow} onPress={handleStartEnroll} disabled={mfaBusy}>
          {mfaBusy ? <ActivityIndicator color={colors.text} /> : <Text style={styles.travelDocsText}>Enable Two-Factor Authentication</Text>}
        </Pressable>
      )}

      <Text style={[styles.sectionTitle, styles.sectionTitleSpaced]}>Appearance</Text>
      <View style={styles.themeRow}>
        {(['system', 'light', 'dark'] as ThemePreference[]).map((option) => (
          <Pressable
            key={option}
            style={[styles.themeOption, preference === option && styles.themeOptionActive]}
            onPress={() => setPreference(option)}
          >
            <Text style={[styles.themeOptionText, preference === option && styles.themeOptionTextActive]}>
              {option === 'system' ? 'System' : option === 'light' ? 'Light' : 'Dark'}
            </Text>
          </Pressable>
        ))}
      </View>

      <Text style={[styles.sectionTitle, styles.sectionTitleSpaced]}>Legal</Text>
      <Pressable style={styles.travelDocsRow} onPress={() => Linking.openURL(PRIVACY_POLICY_URL)}>
        <Text style={styles.travelDocsText}>Privacy Policy</Text>
        <Text style={styles.orgAction}>›</Text>
      </Pressable>
      <Pressable style={styles.travelDocsRow} onPress={() => Linking.openURL(TERMS_OF_SERVICE_URL)}>
        <Text style={styles.travelDocsText}>Terms of Service</Text>
        <Text style={styles.orgAction}>›</Text>
      </Pressable>

      <Pressable style={styles.signOutButton} onPress={signOut}>
        <Text style={styles.signOutButtonText}>Sign Out</Text>
      </Pressable>

      <View style={styles.dangerZone}>
        <Text style={styles.dangerTitle}>Danger Zone</Text>
        <Pressable style={styles.deleteButton} onPress={confirmDeleteAccount} disabled={deleting}>
          {deleting ? <ActivityIndicator color={colors.danger} /> : <Text style={styles.deleteButtonText}>Delete Account</Text>}
        </Pressable>
      </View>
    </ScrollView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    content: { padding: 20, paddingBottom: 60 },
    title: { color: colors.text, fontSize: 26, fontFamily: fonts.displayBlack, letterSpacing: -0.4, marginBottom: 16 },
    error: { color: colors.danger, fontSize: 13, marginBottom: 12, fontFamily: fonts.body },
    avatarSection: { alignItems: 'center', marginBottom: 24 },
    avatar: { width: 88, height: 88, borderRadius: 44, backgroundColor: colors.surface },
    avatarPlaceholder: { alignItems: 'center', justifyContent: 'center' },
    avatarPlaceholderText: { color: colors.textFaint, fontSize: 32, fontFamily: fonts.displayBold },
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
    changePhotoText: { color: colors.accent, fontSize: 13, fontFamily: fonts.bodySemiBold, marginTop: 10, textAlign: 'center' },
    sectionTitle: { color: colors.textDim, fontSize: 12, fontFamily: fonts.bodySemiBold, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
    sectionTitleSpaced: { marginTop: 24 },
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
    readOnlyRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8 },
    readOnlyLabel: { color: colors.textFaint, fontSize: 13, fontFamily: fonts.body },
    readOnlyValue: { color: colors.textDim, fontSize: 13, fontFamily: fonts.body },
    saveButton: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 12 },
    saveButtonText: { color: colors.onAccent, fontSize: 15, fontFamily: fonts.bodySemiBold },
    emptyText: { color: colors.textFaint, fontSize: 13, fontFamily: fonts.body },
    orgRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: 10,
      padding: 12,
      marginBottom: 6,
      borderWidth: 1,
      borderColor: colors.border,
    },
    orgName: { color: colors.text, fontSize: 14, fontFamily: fonts.body },
    orgRole: { color: colors.textFaint, fontSize: 12, fontFamily: fonts.body },
    orgAction: { color: colors.accent, fontSize: 13, fontFamily: fonts.bodySemiBold },
    travelDocsRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: 10,
      padding: 12,
      borderWidth: 1,
      borderColor: colors.border,
    },
    travelDocsText: { color: colors.text, fontSize: 14, fontFamily: fonts.body },
    notesHint: { color: colors.textFaint, fontSize: 12, marginTop: 6, marginBottom: 4, lineHeight: 16, fontFamily: fonts.body },
    tripitLabel: { marginTop: 16 },
    rotateLink: { color: colors.accent, fontSize: 12, fontFamily: fonts.bodySemiBold, marginTop: 4 },
    inputRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
    rowInput: { flex: 1 },
    tripitSaveButton: { backgroundColor: colors.accent, borderRadius: 10, paddingHorizontal: 16, justifyContent: 'center', height: 46 },
    tripitSaveButtonText: { color: colors.onAccent, fontSize: 14, fontFamily: fonts.bodySemiBold },
    themeRow: { flexDirection: 'row', gap: 8 },
    themeOption: {
      flex: 1,
      backgroundColor: colors.surface,
      borderRadius: 10,
      paddingVertical: 12,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.border,
    },
    themeOptionActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    themeOptionText: { color: colors.textDim, fontSize: 13, fontFamily: fonts.bodySemiBold },
    themeOptionTextActive: { color: colors.onAccent },
    pushStatus: { color: colors.success, fontSize: 12, marginTop: 6, marginBottom: 6, fontFamily: fonts.body },
    mfaSetupBox: { backgroundColor: colors.surface, borderRadius: 10, padding: 14, borderWidth: 1, borderColor: colors.border },
    mfaSetupLabel: { color: colors.textDim, fontSize: 12, marginBottom: 8, fontFamily: fonts.body },
    mfaSecret: { color: colors.text, fontSize: 16, fontFamily: fonts.monoMedium, letterSpacing: 1, marginBottom: 6 },
    mfaUri: { color: colors.textFaint, fontSize: 11, marginBottom: 12, fontFamily: fonts.mono },
    mfaSetupActions: { flexDirection: 'row', gap: 10, marginTop: 4 },
    mfaConfirmButton: { flex: 1, marginTop: 0 },
    cancelEnrollButton: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 12 },
    cancelEnrollButtonText: { color: colors.textDim, fontSize: 14, fontFamily: fonts.bodySemiBold },
    mfaDisableText: { color: colors.danger, fontSize: 13, fontFamily: fonts.bodySemiBold },
    signOutButton: { alignItems: 'center', paddingVertical: 14, marginTop: 28 },
    signOutButtonText: { color: colors.textDim, fontSize: 15, fontFamily: fonts.bodySemiBold },
    dangerZone: { marginTop: 20, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 20 },
    dangerTitle: { color: colors.textFaint, fontSize: 12, fontFamily: fonts.bodySemiBold, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 },
    deleteButton: { alignItems: 'center', paddingVertical: 12 },
    deleteButtonText: { color: colors.danger, fontSize: 14, fontFamily: fonts.bodySemiBold },
  });
}
