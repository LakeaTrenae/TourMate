/**
 * MfaChallengeScreen — shown whenever AuthProvider's `mfaChallengePending`
 * flag is set (RootNavigator forces this screen regardless of whatever
 * else is going on, same as ResetPasswordScreen), which happens right
 * after signing in on an account with a verified TOTP factor — the
 * session starts at aal1 and needs one code entry to clear to aal2
 * before anything else in the app is reachable.
 *
 * A fresh challenge is created on mount (`mfa.challenge`) and verified
 * against the 6-digit code the user enters (`mfa.verify`) — on success,
 * Supabase refreshes the session to aal2 and refreshMfaStatus() re-reads
 * that so RootNavigator moves on immediately.
 */
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
} from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';

export function MfaChallengeScreen() {
  const { signOut, refreshMfaStatus } = useAuth();
  const [factorId, setFactorId] = useState<string | null>(null);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [preparing, setPreparing] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    async function prepare() {
      const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();
      if (factorsError) {
        setErrorMessage(factorsError.message);
        setPreparing(false);
        return;
      }
      const totpFactor = factorsData?.totp.find((f) => f.status === 'verified');
      if (!totpFactor) {
        // Shouldn't happen — mfaChallengePending only gets set when a
        // verified factor exists — but fail safely rather than getting
        // stuck on a screen with nothing to challenge.
        setErrorMessage('No active authenticator found.');
        setPreparing(false);
        return;
      }
      setFactorId(totpFactor.id);

      const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({ factorId: totpFactor.id });
      if (challengeError) {
        setErrorMessage(challengeError.message);
        setPreparing(false);
        return;
      }
      setChallengeId(challengeData.id);
      setPreparing(false);
    }
    prepare();
  }, []);

  async function handleVerify() {
    if (!factorId || !challengeId) return;
    setErrorMessage(null);
    if (code.trim().length !== 6) {
      setErrorMessage('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setVerifying(true);
    const { error } = await supabase.auth.mfa.verify({ factorId, challengeId, code: code.trim() });
    setVerifying(false);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    await refreshMfaStatus();
    // On success, RootNavigator takes it from here — mfaChallengePending
    // is now false, so it moves straight into the signed-in app.
  }

  if (preparing) {
    return (
      <KeyboardAvoidingView style={styles.centered}>
        <ActivityIndicator color="#fff" />
      </KeyboardAvoidingView>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Text style={styles.title}>Two-factor verification</Text>
      <Text style={styles.subtitle}>Enter the 6-digit code from your authenticator app.</Text>

      <TextInput
        style={styles.input}
        placeholder="123456"
        placeholderTextColor="#6b6b76"
        value={code}
        onChangeText={setCode}
        keyboardType="number-pad"
        maxLength={6}
        autoFocus
        onSubmitEditing={handleVerify}
      />

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <Pressable style={styles.submitButton} onPress={handleVerify} disabled={verifying || !factorId || !challengeId}>
        {verifying ? <ActivityIndicator color="#0b0b0f" /> : <Text style={styles.submitButtonText}>Verify</Text>}
      </Pressable>

      <Pressable onPress={signOut}>
        <Text style={styles.cancelText}>Cancel and sign out</Text>
      </Pressable>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b0f', justifyContent: 'center', paddingHorizontal: 24 },
  centered: { flex: 1, backgroundColor: '#0b0b0f', alignItems: 'center', justifyContent: 'center' },
  title: { color: '#fff', fontSize: 26, fontWeight: '700', textAlign: 'center' },
  subtitle: { color: '#9a9aa5', fontSize: 14, textAlign: 'center', marginTop: 6, marginBottom: 28 },
  input: {
    backgroundColor: '#1a1a20',
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
    fontSize: 20,
    textAlign: 'center',
    letterSpacing: 6,
  },
  error: { color: '#ff6b6b', fontSize: 13, marginBottom: 12, textAlign: 'center' },
  submitButton: { backgroundColor: '#fff', borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 8, marginBottom: 20 },
  submitButtonText: { color: '#0b0b0f', fontSize: 16, fontWeight: '600' },
  cancelText: { color: '#6b6b76', fontSize: 13, textAlign: 'center' },
});
