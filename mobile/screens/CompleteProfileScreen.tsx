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
 */
import { useState } from 'react';
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

export function CompleteProfileScreen() {
  const { profile, session, refreshProfile, signOut } = useAuth();
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
        placeholderTextColor="#6b6b76"
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
        {submitting ? <ActivityIndicator color="#0b0b0f" /> : <Text style={styles.submitButtonText}>Save</Text>}
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

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b0b0f',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  title: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
  },
  subtitle: {
    color: '#9a9aa5',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 10,
    marginBottom: 28,
    lineHeight: 20,
  },
  input: {
    backgroundColor: '#1a1a20',
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
    fontSize: 16,
  },
  error: {
    color: '#ff6b6b',
    fontSize: 13,
    marginBottom: 12,
  },
  submitButton: {
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 16,
  },
  submitButtonText: {
    color: '#0b0b0f',
    fontSize: 16,
    fontWeight: '600',
  },
  skipText: {
    color: '#9a9aa5',
    fontSize: 13,
    textAlign: 'center',
  },
  footer: {
    marginTop: 40,
    alignItems: 'center',
  },
  signOut: {
    color: '#6b6b76',
    fontSize: 13,
  },
});