/**
 * MessagesScreen — the one cross-tour screen in this app: a direct-
 * message inbox. Everything else in TourMate hangs off a specific tour
 * (that's why a tour's own group chat is opened straight from its
 * Dashboard, not listed here) — direct conversations are the one
 * relationship that's genuinely tour-independent (0047_chat.sql:
 * `direct` conversations carry no tour_id at all), so this is the one
 * screen reachable from TourList's header rather than nested under a
 * tour.
 *
 * N+1 queries per conversation (other participant + latest message) —
 * same "fine at this dataset's realistic size" call BudgetScreen's own
 * per-week/per-category aggregation already makes; nobody's DM inbox
 * here is going to be hundreds of threads deep.
 */
import { useCallback, useMemo, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Messages'>;

type Thread = {
  conversationId: string;
  otherUserId: string;
  otherName: string;
  lastBody: string | null;
  lastAt: string | null;
  unread: boolean;
};

export function MessagesScreen({ navigation }: Props) {
  const { session } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const myId = session?.user.id;

  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!myId) return;
    const { data: mine, error } = await supabase
      .from('conversation_participants')
      .select('conversation_id, last_read_at, conversation:conversations(type)')
      .eq('user_id', myId);
    if (error) throw error;

    const directIds = (mine ?? [])
      .filter((r) => (r.conversation as unknown as { type: string } | null)?.type === 'direct')
      .map((r) => ({ id: r.conversation_id, lastReadAt: r.last_read_at }));

    const resolved = await Promise.all(
      directIds.map(async ({ id, lastReadAt }) => {
        const [{ data: other }, { data: lastMsg }] = await Promise.all([
          supabase
            .from('conversation_participants')
            .select('user_id, profile:profiles(display_name)')
            .eq('conversation_id', id)
            .neq('user_id', myId)
            .maybeSingle(),
          supabase.from('messages').select('body, created_at').eq('conversation_id', id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
        ]);
        const otherRow = other as unknown as { user_id: string; profile: { display_name: string } | null } | null;
        return {
          conversationId: id,
          otherUserId: otherRow?.user_id ?? '',
          otherName: otherRow?.profile?.display_name ?? 'Unknown',
          lastBody: lastMsg?.body ?? null,
          lastAt: lastMsg?.created_at ?? null,
          unread: !!lastMsg && lastMsg.created_at > lastReadAt,
        } as Thread;
      })
    );

    resolved.sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));
    setThreads(resolved);
  }, [myId]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load()
        .catch((err) => setErrorMessage(err instanceof Error ? err.message : 'Failed to load your messages.'))
        .finally(() => setLoading(false));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [myId])
  );

  async function handleRefresh() {
    setRefreshing(true);
    await load().catch(() => {});
    setRefreshing(false);
  }

  async function openThread(thread: Thread) {
    const { data, error } = await supabase.rpc('get_or_create_direct_conversation', { p_other_user_id: thread.otherUserId });
    if (error || !data || data.length === 0) {
      setErrorMessage(error?.message ?? 'Failed to open this conversation.');
      return;
    }
    const row = data[0] as { conversation_id: string; tour_id: string };
    navigation.navigate('ChatThread', { conversationId: row.conversation_id, title: thread.otherName, isGroup: false, tourId: row.tour_id });
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Messages</Text>
      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <ScrollView
        contentContainerStyle={threads.length === 0 && styles.emptyContainer}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.accent} />}
      >
        {threads.length === 0 ? (
          <Text style={styles.emptyText}>
            No conversations yet — start one from a tour's Directory by tapping "Message" on someone's profile.
          </Text>
        ) : (
          threads.map((t) => (
            <Pressable key={t.conversationId} style={styles.row} onPress={() => openThread(t)}>
              <View style={styles.rowMain}>
                <Text style={[styles.rowName, t.unread && styles.rowNameUnread]}>{t.otherName}</Text>
                <Text style={styles.rowPreview} numberOfLines={1}>
                  {t.lastBody ?? 'No messages yet'}
                </Text>
              </View>
              {t.unread && <View style={styles.unreadDot} />}
            </Pressable>
          ))
        )}
      </ScrollView>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg, paddingTop: 60, paddingHorizontal: 20 },
    centered: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
    title: { color: colors.text, fontSize: 36, fontFamily: fonts.displayBlack, letterSpacing: -0.6, marginBottom: 16 },
    error: { color: colors.danger, fontSize: 16, marginBottom: 12, fontFamily: fonts.body },
    emptyContainer: { flexGrow: 1, justifyContent: 'center' },
    emptyText: { color: colors.textFaint, fontSize: 17, textAlign: 'center', lineHeight: 20, fontFamily: fonts.body },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: 12,
      padding: 14,
      marginBottom: 8,
    },
    rowMain: { flex: 1 },
    rowName: { color: colors.text, fontSize: 18, fontFamily: fonts.displaySemiBold },
    rowNameUnread: { color: colors.accent },
    rowPreview: { color: colors.textDim, fontSize: 16, marginTop: 2, fontFamily: fonts.body },
    unreadDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.spark, marginLeft: 10 },
  });
}
