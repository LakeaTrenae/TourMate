/**
 * CreateOrganizationScreen — the actual entry point into the app for
 * anyone who isn't already on someone else's tour. Tours belong to an
 * organization (band, production company, etc.), so this has to exist
 * before a tour can. Whoever creates it automatically becomes its
 * `owner` — see the `handle_new_organization` trigger in
 * 0008_org_creation_and_existing_user_invites.sql.
 *
 * Theme (Manrope/JetBrains Mono, navy accent) per the "Load-In" design
 * review — see lib/theme.tsx.
 */
import { useMemo, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { newId } from '../lib/ids';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'CreateOrganization'>;

export function CreateOrganizationScreen({ navigation }: Props) {
  const { session } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit() {
    setErrorMessage(null);
    if (!session) return;
    if (!name.trim()) {
      setErrorMessage('Enter a name.');
      return;
    }

    setSubmitting(true);
    const organizationId = newId();
    // Slug just needs to be unique — not shown anywhere yet, so a
    // simple name+id derivation is enough rather than a real slugify.
    const slug = `${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${organizationId.slice(0, 8)}`;

    const { error } = await supabase.from('organizations').insert({
      id: organizationId,
      name: name.trim(),
      slug,
      created_by: session.user.id,
    });
    setSubmitting(false);

    if (error) {
      setErrorMessage(error.message);
      return;
    }
    navigation.replace('CreateTour', { organizationId });
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Set up your organization</Text>
      <Text style={styles.subtitle}>
        This is the band, production company, or crew that your tours belong to. You'll be its
        owner.
      </Text>

      <TextInput
        style={styles.input}
        placeholder="e.g. Jhené Aiko Touring"
        placeholderTextColor={colors.textFaint}
        value={name}
        onChangeText={setName}
        autoCapitalize="words"
        autoFocus
      />

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <Pressable style={styles.submitButton} onPress={handleSubmit} disabled={submitting}>
        {submitting ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.submitButtonText}>Continue</Text>}
      </Pressable>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg, justifyContent: 'center', paddingHorizontal: 24 },
    title: { color: colors.text, fontSize: 26, fontFamily: fonts.displayBlack, textAlign: 'center', letterSpacing: -0.4 },
    subtitle: { color: colors.textDim, fontSize: 14, textAlign: 'center', marginTop: 10, marginBottom: 28, lineHeight: 20, fontFamily: fonts.body },
    input: {
      backgroundColor: colors.surface,
      color: colors.text,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      marginBottom: 16,
      fontSize: 16,
      fontFamily: fonts.body,
      borderWidth: 1,
      borderColor: colors.border,
    },
    error: { color: colors.danger, fontSize: 13, marginBottom: 12, fontFamily: fonts.body },
    submitButton: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
    submitButtonText: { color: colors.onAccent, fontSize: 16, fontFamily: fonts.bodySemiBold },
  });
}
