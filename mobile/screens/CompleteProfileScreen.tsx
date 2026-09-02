/**
 * CompleteProfileScreen — shown once, right after signup, before a user
 * can see their tours. Collects a preferred name: what everyone else on a
 * tour actually sees (in the People directory, schedule, etc.) instead of
 * their legal first/last name from signup.
 *
 * Gating logic lives in App.tsx: rendered whenever there's a session but
 * `profile.preferred_name` is still null. Skippable — leaving it blank
 * just means `display_name` falls back to first_name (see the generated
 * column in 0006_profile_names.sql), so nobody gets stuck here.
 *
 * Theme (Manrope/JetBrains Mono, navy accent) per the "Load-In" design
 * review — see lib/theme.tsx.
 */
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';

export function CompleteProfileScreen() {
  const { profile, session, refreshProfile, signOut } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [preferredName, setPreferredName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSave(skip: boolean) {
    if (!session) return;
    setErrorMessage(null);
    setSubmitting(true);

    // Saving an empty string, not null, when skipped: the generated
    // display_name column treats '' the same as null via nullif(), but an
    // empty string (rather than leaving the column untouched) is what
    // marks this step as "done" so the app doesn't ask again next launch.
    const { error } = await supabase
      .from('profiles')
      .update({ preferred_name: skip ? '' : preferredName.trim() })
      .eq('id', session.user.id);

    setSubmitting(false);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    await refreshProfile();
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Text style={styles.title}>Almost there</Text>
      <Text style={styles.subtitle}>
        What should the rest of your tour call you? This is the name everyone else will see —
        it doesn't have to match your legal name.
      </Text>

      <TextInput
        style={styles.input}
        placeholder={profile?.first_name ?? 'Preferred name'}
        placeholderTextColor={colors.textFaint}
        value={preferredName}
        onChangeText={setPreferredName}
        autoCapitalize="words"
        autoFocus
      />

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <Pressable
        style={styles.submitButton}
        onPress={() => handleSave(false)}
        disabled={submitting || !preferredName.trim()}
      >
        {submitting ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.submitButtonText}>Save</Text>}
      </Pressable>

      <Pressable onPress={() => handleSave(true)} disabled={submitting}>
        <Text style={styles.skipText}>Skip — just use {profile?.first_name ?? 'my first name'}</Text>
      </Pressable>

      <View style={styles.footer}>
        <Pressable onPress={signOut}>
          <Text style={styles.signOut}>Sign out</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.bg,
      justifyContent: 'center',
      paddingHorizontal: 24,
    },
    title: {
      color: colors.text,
      fontSize: 28,
      fontFamily: fonts.displayBlack,
      textAlign: 'center',
      letterSpacing: -0.4,
    },
    subtitle: {
      color: colors.textDim,
      fontSize: 14,
      textAlign: 'center',
      marginTop: 10,
      marginBottom: 28,
      lineHeight: 20,
      fontFamily: fonts.body,
    },
    input: {
      backgroundColor: colors.surface,
      color: colors.text,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      marginBottom: 12,
      fontSize: 16,
      fontFamily: fonts.body,
      borderWidth: 1,
      borderColor: colors.border,
    },
    error: {
      color: colors.danger,
      fontSize: 13,
      marginBottom: 12,
      fontFamily: fonts.body,
    },
    submitButton: {
      backgroundColor: colors.accent,
      borderRadius: 10,
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: 8,
      marginBottom: 16,
    },
    submitButtonText: {
      color: colors.onAccent,
      fontSize: 16,
      fontFamily: fonts.bodySemiBold,
    },
    skipText: {
      color: colors.textDim,
      fontSize: 13,
      textAlign: 'center',
      fontFamily: fonts.body,
    },
    footer: {
      marginTop: 40,
      alignItems: 'center',
    },
    signOut: {
      color: colors.textFaint,
      fontSize: 13,
      fontFamily: fonts.body,
    },
  });
}
