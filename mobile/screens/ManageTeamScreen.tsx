/**
 * ManageTeamScreen — the roster, in one place: current members you can
 * remove, and pending invites you can cancel. The "+ Invite" button is
 * the add half of this pair (InviteMemberScreen).
 *
 * Removing a member deletes their tour_members row — RLS
 * ("tour_members deletable by managers", 0002_policy_gaps.sql) means
 * only a manager-tier person can actually do this, regardless of what
 * this screen shows.
 *
 * Theme (Manrope/JetBrains Mono, navy accent) per the "Load-In" design
 * review — see lib/theme.tsx.
 */
import { useCallback, useMemo, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { formatRole, formatDepartment } from '../lib/format';
import { logAuditEvent } from '../lib/auditLog';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'ManageTeam'>;

type Member = {
  user_id: string;
  role: string;
  department: string;
  profile: { display_name: string; email: string } | null;
};
type Invite = {
  id: string;
  full_name: string;
  email: string;
  role: string;
  department: string;
  status: string;
};

export function ManageTeamScreen({ route, navigation }: Props) {
  const { tourId, tourName } = route.params;
  const { session } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Fire-and-forget — looks up this tour's org, then asks sync-org-seats
  // to push a fresh seat count to Stripe if the org has an active
  // subscription. Silently no-ops if the org isn't subscribed yet
  // (sync-org-seats itself returns a clean 400 in that case).
  async function resyncOrgSeats() {
    try {
      const { data: tour } = await supabase.from('tours').select('organization_id').eq('id', tourId).single();
      if (!tour?.organization_id) return;
      await supabase.functions.invoke('sync-org-seats', { body: { orgId: tour.organization_id } });
    } catch {
      // best-effort — never surfaced to the user
    }
  }

  async function load() {
    const [{ data: memberRows, error: memberError }, { data: inviteRows, error: inviteError }] = await Promise.all([
      supabase.from('tour_members').select('user_id, role, department, profile:profiles(display_name, email)').eq('tour_id', tourId),
      supabase
        .from('tour_invites')
        .select('id, full_name, email, role, department, status')
        .eq('tour_id', tourId)
        .eq('status', 'pending'),
    ]);
    if (memberError) setErrorMessage(memberError.message);
    if (inviteError) setErrorMessage(inviteError.message);
    setMembers((memberRows ?? []) as unknown as Member[]);
    setInvites(inviteRows ?? []);
  }

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load().finally(() => setLoading(false));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tourId])
  );

  async function handleRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  function confirmRemoveMember(member: Member) {
    const isSelf = member.user_id === session?.user.id;
    Alert.alert(
      isSelf ? 'Leave this tour?' : `Remove ${member.profile?.display_name ?? 'this person'}?`,
      isSelf ? "You'll lose access to this tour's information." : "They'll lose access to this tour's information.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: isSelf ? 'Leave' : 'Remove',
          style: 'destructive',
          onPress: async () => {
            const { error } = await supabase.from('tour_members').delete().eq('tour_id', tourId).eq('user_id', member.user_id);
            if (error) {
              setErrorMessage(error.message);
              return;
            }
            if (session) {
              logAuditEvent({
                tourId,
                actorId: session.user.id,
                action: 'delete',
                resourceType: 'tour_member',
                resourceId: member.user_id,
                detail: { display_name: member.profile?.display_name, role: member.role, self: isSelf },
              });
              // Best-effort seat resync (fire-and-forget, mirrors
              // logAuditEvent/notify's pattern) — a removal is one of the
              // few roster changes that's both synchronous and
              // client-visible enough to resync from; see
              // compute_org_seat_count's own comment for why this isn't
              // the primary reconciliation mechanism (it's recomputed
              // live on every BillingScreen visit regardless).
              resyncOrgSeats();
            }
            if (isSelf) {
              navigation.navigate('TourList');
              return;
            }
            await load();
          },
        },
      ]
    );
  }

  function confirmCancelInvite(invite: Invite) {
    Alert.alert('Cancel invite?', `${invite.full_name} (${invite.email})`, [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Cancel Invite',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('tour_invites').delete().eq('id', invite.id);
          if (error) setErrorMessage(error.message);
          else await load();
        },
      },
    ]);
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.accent} />}
    >
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Team</Text>
          <Text style={styles.subtitle}>{tourName}</Text>
        </View>
        <Pressable style={styles.addButton} onPress={() => navigation.navigate('InviteMember', { tourId })}>
          <Text style={styles.addButtonText}>+ Invite</Text>
        </Pressable>
      </View>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <Text style={styles.sectionTitle}>On this tour</Text>
      {members.length === 0 && <Text style={styles.emptyText}>No one on the roster yet.</Text>}
      {members.map((m) => (
        <Pressable key={m.user_id} style={styles.card} onLongPress={() => confirmRemoveMember(m)}>
          <View>
            <Text style={styles.name}>{m.profile?.display_name ?? 'Unknown'}</Text>
            <Text style={styles.meta}>
              {formatRole(m.role)} · {formatDepartment(m.department)}
            </Text>
          </View>
          <Pressable style={styles.deleteButton} onPress={() => confirmRemoveMember(m)}>
            <Text style={styles.deleteButtonText}>Remove</Text>
          </Pressable>
        </Pressable>
      ))}

      {invites.length > 0 && (
        <>
          <Text style={[styles.sectionTitle, styles.sectionTitleSpaced]}>Pending invites</Text>
          {invites.map((inv) => (
            <Pressable key={inv.id} style={styles.card} onLongPress={() => confirmCancelInvite(inv)}>
              <View>
                <Text style={styles.name}>{inv.full_name}</Text>
                <Text style={styles.meta}>
                  {inv.email} · {formatRole(inv.role)} · {formatDepartment(inv.department)}
                </Text>
              </View>
              <View style={styles.inviteActions}>
                <Text style={styles.pendingBadge}>Pending</Text>
                <Pressable style={styles.deleteButton} onPress={() => confirmCancelInvite(inv)}>
                  <Text style={styles.deleteButtonText}>Cancel</Text>
                </Pressable>
              </View>
            </Pressable>
          ))}
        </>
      )}
    </ScrollView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    centered: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
    content: { padding: 20, paddingTop: 20, paddingBottom: 60 },
    header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 },
    title: { color: colors.text, fontSize: 26, fontFamily: fonts.displayBlack, letterSpacing: -0.4 },
    subtitle: { color: colors.textDim, fontSize: 13, marginTop: 2, fontFamily: fonts.body },
    addButton: { backgroundColor: colors.accent, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
    addButtonText: { color: colors.onAccent, fontSize: 13, fontFamily: fonts.bodySemiBold },
    error: { color: colors.danger, fontSize: 13, marginBottom: 12, fontFamily: fonts.body },
    sectionTitle: { color: colors.textDim, fontSize: 12, fontFamily: fonts.bodySemiBold, textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 },
    sectionTitleSpaced: { marginTop: 20 },
    emptyText: { color: colors.textFaint, fontSize: 13, marginBottom: 8, fontFamily: fonts.body },
    card: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: 12,
      padding: 14,
      marginBottom: 8,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.08,
      shadowRadius: 10,
      elevation: 2,
    },
    name: { color: colors.text, fontSize: 14, fontFamily: fonts.displaySemiBold },
    meta: { color: colors.textDim, fontSize: 12, marginTop: 2, fontFamily: fonts.body },
    pendingBadge: { color: colors.warn, fontSize: 11, fontFamily: fonts.bodySemiBold, textTransform: 'uppercase' },
    inviteActions: { alignItems: 'flex-end', gap: 6 },
    deleteButton: { backgroundColor: colors.dangerSoft, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
    deleteButtonText: { color: colors.danger, fontSize: 12, fontFamily: fonts.bodySemiBold },
  });
}
