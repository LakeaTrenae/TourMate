/**
 * ResetPasswordScreen — shown whenever AuthProvider's `passwordRecovery`
 * flag is set (RootNavigator forces this screen regardless of whatever
 * else is going on), which happens after opening the link from
 * requestPasswordReset's email. Supabase has already exchanged that
 * link's token for a temporary session by this point — this screen just
 * collects the new password and calls updateUser.
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
} from 'react-native';

import { useAuth } from '../lib/auth-context';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';

export function ResetPasswordScreen() {
  const { updatePassword, signOut } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
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
        placeholderTextColor={colors.textFaint}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="new-password"
      />
      <TextInput
        style={styles.input}
        placeholder="Confirm password"
        placeholderTextColor={colors.textFaint}
        value={confirm}
        onChangeText={setConfirm}
        secureTextEntry
        autoComplete="new-password"
      />

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <Pressable style={styles.submitButton} onPress={handleSubmit} disabled={submitting}>
        {submitting ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.submitButtonText}>Update Password</Text>}
      </Pressable>

      <Pressable onPress={signOut}>
        <Text style={styles.cancelText}>Cancel and sign out</Text>
      </Pressable>
    </KeyboardAvoidingView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg, justifyContent: 'center', paddingHorizontal: 24 },
    title: { color: colors.text, fontSize: 26, fontFamily: fonts.displayBlack, textAlign: 'center', letterSpacing: -0.4 },
    subtitle: { color: colors.textDim, fontSize: 14, textAlign: 'center', marginTop: 6, marginBottom: 28, fontFamily: fonts.body },
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
    error: { color: colors.danger, fontSize: 13, marginBottom: 12, fontFamily: fonts.body },
    submitButton: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 8, marginBottom: 20 },
    submitButtonText: { color: colors.onAccent, fontSize: 16, fontFamily: fonts.bodySemiBold },
    cancelText: { color: colors.textFaint, fontSize: 13, textAlign: 'center', fontFamily: fonts.body },
  });
}
