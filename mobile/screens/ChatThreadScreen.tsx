/**
 * ChatThreadScreen — one message thread, group or direct. Works for both
 * conversation_type values (0047_chat.sql) given a resolved
 * `conversationId` — the caller always arrives here already past
 * get_or_create_tour_conversation/get_or_create_direct_conversation, so
 * this screen itself never needs to know which RPC produced the id.
 *
 * Realtime (not polling) for new messages — the one screen in this app
 * where that actually matters: a chat feels broken if the other person's
 * reply only shows up after a manual pull-to-refresh. Supabase Realtime
 * subscribes to postgres_changes INSERT on `messages`, filtered to this
 * conversation_id (0047 adds `messages` to the supabase_realtime
 * publication — nothing else in this app needed that).
 *
 * Read tracking: upserts this user's own conversation_participants row
 * (last_read_at = now()) on focus and right after sending — "upsertable/
 * updatable by self" (0047) is exactly scoped for this, no RPC needed.
 *
 * Push notifications are best-effort and separate from the send itself —
 * a failed notify() should never make a successfully-sent message look
 * like it failed.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { notify } from '../lib/notify';
import { newId } from '../lib/ids';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'ChatThread'>;

type MessageRow = { id: string; sender_id: string; body: string; created_at: string };
type Participant = { user_id: string; display_name: string };

export function ChatThreadScreen({ route }: Props) {
  const { conversationId, title, isGroup, tourId } = route.params;
  const { session } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const myId = session?.user.id;

  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);

  const nameOf = useCallback(
    (userId: string) => participants.find((p) => p.user_id === userId)?.display_name ?? 'Unknown',
    [participants]
  );

  async function markRead() {
    if (!myId) return;
    await supabase
      .from('conversation_participants')
      .upsert({ conversation_id: conversationId, user_id: myId, last_read_at: new Date().toISOString() });
  }

  const load = useCallback(async () => {
    const [{ data: messageRows, error: messagesError }, participantRows] = await Promise.all([
      supabase
        .from('messages')
        .select('id, sender_id, body, created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true }),
      isGroup
        ? supabase.from('tour_members').select('user_id, profile:profiles(display_name)').eq('tour_id', tourId)
        : supabase
            .from('conversation_participants')
            .select('user_id, profile:profiles(display_name)')
            .eq('conversation_id', conversationId),
    ]);
    if (messagesError) throw messagesError;
    setMessages(messageRows ?? []);

    const rows = (participantRows.data ?? []) as unknown as { user_id: string; profile: { display_name: string } | null }[];
    setParticipants(rows.map((r) => ({ user_id: r.user_id, display_name: r.profile?.display_name ?? 'Unknown' })));

    await markRead();
  }, [conversationId, isGroup, tourId]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load()
        .catch((err) => setErrorMessage(err instanceof Error ? err.message : 'Failed to load this conversation.'))
        .finally(() => setLoading(false));
      return () => {
        markRead();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [conversationId])
  );

  // Live new-message delivery. Guards against double-adding the message
  // this same client just sent (handleSend already appends it locally
  // for instant feedback) by de-duping on id.
  useEffect(() => {
    const channel = supabase
      .channel(`messages:${conversationId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
        (payload) => {
          const row = payload.new as MessageRow;
          setMessages((prev) => (prev.some((m) => m.id === row.id) ? prev : [...prev, row]));
          if (row.sender_id !== myId) markRead();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  async function handleSend() {
    const body = draft.trim();
    if (!body || !myId) return;
    setSending(true);
    setDraft('');

    const id = newId();
    const optimistic: MessageRow = { id, sender_id: myId, body, created_at: new Date().toISOString() };
    setMessages((prev) => [...prev, optimistic]);

    const { error } = await supabase.from('messages').insert({ id, conversation_id: conversationId, sender_id: myId, body });
    setSending(false);
    if (error) {
      setErrorMessage(error.message);
      setMessages((prev) => prev.filter((m) => m.id !== id));
      setDraft(body);
      return;
    }
    await markRead();

    const targets = participants.filter((p) => p.user_id !== myId).map((p) => p.user_id);
    if (targets.length > 0) {
      notify({ tourId, targetUserIds: targets, title: isGroup ? title : nameOf(myId), body });
    }
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <>
          {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}
          <ScrollView
            ref={scrollRef}
            style={styles.messageList}
            contentContainerStyle={styles.messageListContent}
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
          >
            {messages.length === 0 ? (
              <Text style={styles.emptyText}>No messages yet — say something.</Text>
            ) : (
              messages.map((m) => {
                const mine = m.sender_id === myId;
                return (
                  <View key={m.id} style={[styles.bubbleRow, mine && styles.bubbleRowMine]}>
                    <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
                      {isGroup && !mine && <Text style={styles.senderName}>{nameOf(m.sender_id)}</Text>}
                      <Text style={[styles.bubbleText, mine && styles.bubbleTextMine]}>{m.body}</Text>
                      <Text style={[styles.bubbleTime, mine && styles.bubbleTimeMine]}>
                        {new Date(m.created_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                      </Text>
                    </View>
                  </View>
                );
              })
            )}
          </ScrollView>

          <View style={styles.composerRow}>
            <TextInput
              style={styles.composerInput}
              value={draft}
              onChangeText={setDraft}
              placeholder="Message…"
              placeholderTextColor={colors.textFaint}
              multiline
            />
            <Pressable style={[styles.sendButton, !draft.trim() && styles.sendButtonDisabled]} onPress={handleSend} disabled={!draft.trim() || sending}>
              <Text style={styles.sendButtonText}>Send</Text>
            </Pressable>
          </View>
        </>
      )}
    </KeyboardAvoidingView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    error: { color: colors.danger, fontSize: 13, padding: 12, fontFamily: fonts.body },
    messageList: { flex: 1 },
    messageListContent: { padding: 16, flexGrow: 1 },
    emptyText: { color: colors.textFaint, fontSize: 14, textAlign: 'center', marginTop: 40, fontFamily: fonts.body },
    bubbleRow: { flexDirection: 'row', marginBottom: 8 },
    bubbleRowMine: { justifyContent: 'flex-end' },
    bubble: {
      maxWidth: '78%',
      borderRadius: 14,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    bubbleTheirs: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
    bubbleMine: { backgroundColor: colors.accent },
    senderName: { color: colors.accent, fontSize: 10, fontFamily: fonts.bodySemiBold, marginBottom: 2 },
    bubbleText: { color: colors.text, fontSize: 15, fontFamily: fonts.body, lineHeight: 20 },
    bubbleTextMine: { color: colors.onAccent },
    bubbleTime: { color: colors.textFaint, fontSize: 10, fontFamily: fonts.mono, marginTop: 3, textAlign: 'right' },
    bubbleTimeMine: { color: colors.onAccent, opacity: 0.7 },
    composerRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 8,
      padding: 12,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: colors.bg,
    },
    composerInput: {
      flex: 1,
      backgroundColor: colors.surface,
      color: colors.text,
      borderRadius: 18,
      paddingHorizontal: 14,
      paddingVertical: 10,
      fontSize: 15,
      fontFamily: fonts.body,
      borderWidth: 1,
      borderColor: colors.border,
      maxHeight: 100,
    },
    sendButton: { backgroundColor: colors.accent, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 10 },
    sendButtonDisabled: { opacity: 0.5 },
    sendButtonText: { color: colors.onAccent, fontSize: 14, fontFamily: fonts.bodySemiBold },
  });
}
