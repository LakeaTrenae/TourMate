/**
 * InviteMemberScreen — assign a role by name and contact, before the
 * person even has an account. If they already have one, the
 * handle_new_invite trigger attaches them immediately; otherwise
 * handle_new_user attaches them the moment they sign up with a matching
 * email — see 0004/0008.
 *
 * Owner/Admin are offered here, but granting them is gated at the
 * database level (0018_invite_role_escalation_guard.sql) to whoever
 * already holds that authority — a plain manager selecting "Owner" will
 * get a clear rejection from the insert, not a silent escalation.
 *
 * Theme (Manrope/JetBrains Mono, navy accent) per the "Load-In" design
 * review — see lib/theme.tsx.
 */
import { useMemo, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'InviteMember'>;

const ROLES = ['crew', 'manager', 'admin', 'owner'] as const;
const DEPARTMENTS = ['general', 'production', 'security', 'travel', 'artist_relations', 'finance', 'tour_management'] as const;

function label(value: string) {
  return value.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export function InviteMemberScreen({ route, navigation }: Props) {
  const { tourId } = route.params;
  const { session } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<(typeof ROLES)[number]>('crew');
  const [department, setDepartment] = useState<(typeof DEPARTMENTS)[number]>('general');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit() {
    setErrorMessage(null);
    if (!session) return;

    if (!fullName.trim() || !email.trim()) {
      setErrorMessage('Enter a name and email.');
      return;
    }

    setSubmitting(true);
    const { error } = await supabase.from('tour_invites').insert({
      tour_id: tourId,
      full_name: fullName.trim(),
      email: email.trim().toLowerCase(),
      phone: phone.trim() || null,
      role,
      department,
      invited_by: session.user.id,
    });
    setSubmitting(false);

    if (error) {
      // The RLS policy is what actually enforces "can I grant this role" —
      // a rejected owner/admin grant surfaces here as a plain permission
      // error, not a crash.
      setErrorMessage(
        error.message.includes('row-level security')
          ? "You don't have permission to grant that role — try Manager or Crew instead."
          : error.message
      );
      return;
    }
    navigation.goBack();
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Invite Someone</Text>

      <TextInput style={styles.input} placeholder="Full name" placeholderTextColor={colors.textFaint} value={fullName} onChangeText={setFullName} autoCapitalize="words" />
      <TextInput style={styles.input} placeholder="Email" placeholderTextColor={colors.textFaint} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
      <TextInput style={styles.input} placeholder="Phone (optional)" placeholderTextColor={colors.textFaint} value={phone} onChangeText={setPhone} keyboardType="phone-pad" />

      <Text style={styles.sectionTitle}>Role</Text>
      <View style={styles.chipRow}>
        {ROLES.map((r) => (
          <Pressable key={r} style={[styles.chip, role === r && styles.chipActive]} onPress={() => setRole(r)}>
            <Text style={[styles.chipText, role === r && styles.chipTextActive]}>{label(r)}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.sectionTitle}>Department</Text>
      <View style={styles.chipRow}>
        {DEPARTMENTS.map((d) => (
          <Pressable key={d} style={[styles.chip, department === d && styles.chipActive]} onPress={() => setDepartment(d)}>
            <Text style={[styles.chipText, department === d && styles.chipTextActive]}>{label(d)}</Text>
          </Pressable>
        ))}
      </View>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <Pressable style={styles.submitButton} onPress={handleSubmit} disabled={submitting}>
        {submitting ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.submitButtonText}>Send Invite</Text>}
      </Pressable>
    </ScrollView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    content: { padding: 20, paddingBottom: 60 },
    title: { color: colors.text, fontSize: 22, fontFamily: fonts.displayBold, marginBottom: 16 },
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
    sectionTitle: { color: colors.textDim, fontSize: 12, fontFamily: fonts.bodySemiBold, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 12, marginBottom: 8 },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: { backgroundColor: colors.surface2, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 },
    chipActive: { backgroundColor: colors.accent },
    chipText: { color: colors.textDim, fontSize: 13, fontFamily: fonts.bodySemiBold },
    chipTextActive: { color: colors.onAccent },
    error: { color: colors.danger, fontSize: 13, marginTop: 12, fontFamily: fonts.body },
    submitButton: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 20 },
    submitButtonText: { color: colors.onAccent, fontSize: 16, fontFamily: fonts.bodySemiBold },
  });
}
