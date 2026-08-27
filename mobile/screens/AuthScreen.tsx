/**
 * AuthScreen — sign in, create an account, or request a password reset.
 * Three modes on one screen rather than separate ones, since the form is
 * almost identical (email/password) with just extra fields on sign-up.
 *
 * Security note: this screen intentionally does NOT implement its own
 * password rules, rate limiting, or brute-force protection — Supabase Auth
 * already enforces password strength and rate-limits auth attempts
 * server-side. Duplicating that logic client-side would be redundant at
 * best and give a false sense of security at worst (client-side checks
 * are always bypassable).
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

import { useAuth } from '../lib/auth-context';

type Mode = 'sign-in' | 'sign-up' | 'forgot';

export function AuthScreen() {
  const { signInWithPassword, signUp, requestPasswordReset } = useAuth();

  const [mode, setMode] = useState<Mode>('sign-in');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState(false);

  const isSignUp = mode === 'sign-up';
  const isForgot = mode === 'forgot';

  function switchMode(next: Mode) {
    setErrorMessage(null);
    setResetSent(false);
    setMode(next);
  }

  async function handleSubmit() {
    setErrorMessage(null);

    // Minimal client-side validation — just enough to avoid a pointless
    // round trip for an obviously-empty field. Real validation (password
    // strength, duplicate email, etc.) happens server-side in Supabase Auth.
    if (!email.trim()) {
      setErrorMessage('Enter your email.');
      return;
    }
    if (isForgot) {
      setSubmitting(true);
      const { error } = await requestPasswordReset(email.trim());
      setSubmitting(false);
      if (error) setErrorMessage(error);
      else setResetSent(true);
      return;
    }

    if (!password) {
      setErrorMessage('Enter your password.');
      return;
    }
    if (isSignUp && (!firstName.trim() || !lastName.trim())) {
      setErrorMessage('Enter your first and last name.');
      return;
    }

    setSubmitting(true);
    const { error } = isSignUp
      ? await signUp(email.trim(), password, firstName.trim(), lastName.trim())
      : await signInWithPassword(email.trim(), password);
    setSubmitting(false);

    if (error) {
      setErrorMessage(error);
    }
    // On success there's nothing else to do here — the auth-state listener
    // in AuthProvider picks up the new session automatically and the
    // navigation shell (App.tsx) switches away from this screen on its own.
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Text style={styles.title}>TourMate</Text>
      <Text style={styles.subtitle}>
        {isForgot ? 'Reset your password' : isSignUp ? 'Create your account' : 'Sign in to your tours'}
      </Text>

      {isSignUp && (
        <>
          <TextInput
            style={styles.input}
            placeholder="First name"
            placeholderTextColor="#6b6b76"
            value={firstName}
            onChangeText={setFirstName}
            autoCapitalize="words"
            autoComplete="given-name"
          />
          <TextInput
            style={styles.input}
            placeholder="Last name"
            placeholderTextColor="#6b6b76"
            value={lastName}
            onChangeText={setLastName}
            autoCapitalize="words"
            autoComplete="family-name"
          />
          {/* You'll be able to set a preferred name — what everyone on a
              tour actually sees — right after this, on the profile-setup
              screen. First/last name here is just the account identity. */}
          <Text style={styles.hint}>You can set a preferred name after signing up.</Text>
        </>
      )}

      {resetSent ? (
        <Text style={styles.hint}>
          If an account exists for {email.trim()}, a reset link is on its way. Open it to set a new
          password.
        </Text>
      ) : (
        <>
          <TextInput
            style={styles.input}
            placeholder="Email"
            placeholderTextColor="#6b6b76"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
          />

          {!isForgot && (
            <TextInput
              style={styles.input}
              placeholder="Password"
              placeholderTextColor="#6b6b76"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete={isSignUp ? 'new-password' : 'current-password'}
            />
          )}

          {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

          <Pressable style={styles.submitButton} onPress={handleSubmit} disabled={submitting}>
            {submitting ? (
              <ActivityIndicator color="#0b0b0f" />
            ) : (
              <Text style={styles.submitButtonText}>
                {isForgot ? 'Send reset link' : isSignUp ? 'Create account' : 'Sign in'}
              </Text>
            )}
          </Pressable>
        </>
      )}

      {!isForgot && (
        <Pressable onPress={() => switchMode(isSignUp ? 'sign-in' : 'sign-up')}>
          <Text style={styles.toggleText}>
            {isSignUp ? 'Already have an account? Sign in' : "Don't have an account? Create one"}
          </Text>
        </Pressable>
      )}

      {mode === 'sign-in' && (
        <Pressable onPress={() => switchMode('forgot')}>
          <Text style={styles.toggleTextSecondary}>Forgot password?</Text>
        </Pressable>
      )}

      {isForgot && (
        <Pressable onPress={() => switchMode('sign-in')}>
          <Text style={styles.toggleText}>Back to sign in</Text>
        </Pressable>
      )}
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
    fontSize: 32,
    fontWeight: '700',
    textAlign: 'center',
  },
  subtitle: {
    color: '#9a9aa5',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 6,
    marginBottom: 32,
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
  hint: {
    color: '#6b6b76',
    fontSize: 12,
    marginBottom: 12,
    marginTop: -4,
    lineHeight: 18,
  },
  submitButton: {
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 20,
  },
  submitButtonText: {
    color: '#0b0b0f',
    fontSize: 16,
    fontWeight: '600',
  },
  toggleText: {
    color: '#9a9aa5',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 4,
  },
  toggleTextSecondary: {
    color: '#6b6b76',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 10,
  },
});