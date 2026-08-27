/**
 * ResetPasswordScreen — shown whenever AuthProvider's `passwordRecovery`
 * flag is set (RootNavigator forces this screen regardless of whatever
 * else is going on), which happens after opening the link from
 * requestPasswordReset's email. Supabase has already exchanged that
 * link's token for a temporary session by this point — this screen just
 * collects the new password and calls updateUser.
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
} from 'react-native';

import { useAuth } from '../lib/auth-context';

export function ResetPasswordScreen() {
  const { updatePassword, signOut } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit() {
    setErrorMessage(null);
    if (password.length < 6) {
      setErrorMessage('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirm) {
      setErrorMessage("Passwords don't match.");
      return;
    }

    setSubmitting(true);
    const { error } = await updatePassword(password);
    setSubmitting(false);

    if (error) setErrorMessage(error);
    // On success, updatePassword clears passwordRecovery — RootNavigator
    // takes it from there (straight into the signed-in app, since this
    // flow already leaves them with a valid session).
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Text style={styles.title}>Set a new password</Text>
      <Text style={styles.subtitle}>Choose something you haven't used before.</Text>

      <TextInput
        style={styles.input}
        placeholder="New password"
        placeholderTextColor="#6b6b76"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="new-password"
      />
      <TextInput
        style={styles.input}
        placeholder="Confirm password"
        placeholderTextColor="#6b6b76"
        value={confirm}
        onChangeText={setConfirm}
        secureTextEntry
        autoComplete="new-password"
      />

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <Pressable style={styles.submitButton} onPress={handleSubmit} disabled={submitting}>
        {submitting ? <ActivityIndicator color="#0b0b0f" /> : <Text style={styles.submitButtonText}>Update Password</Text>}
      </Pressable>

      <Pressable onPress={signOut}>
        <Text style={styles.cancelText}>Cancel and sign out</Text>
      </Pressable>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b0f', justifyContent: 'center', paddingHorizontal: 24 },
  title: { color: '#fff', fontSize: 26, fontWeight: '700', textAlign: 'center' },
  subtitle: { color: '#9a9aa5', fontSize: 14, textAlign: 'center', marginTop: 6, marginBottom: 28 },
  input: {
    backgroundColor: '#1a1a20',
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
    fontSize: 16,
  },
  error: { color: '#ff6b6b', fontSize: 13, marginBottom: 12 },
  submitButton: { backgroundColor: '#fff', borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 8, marginBottom: 20 },
  submitButtonText: { color: '#0b0b0f', fontSize: 16, fontWeight: '600' },
  cancelText: { color: '#6b6b76', fontSize: 13, textAlign: 'center' },
});