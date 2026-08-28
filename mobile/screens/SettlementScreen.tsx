/**
 * SettlementScreen — end-of-show reconciliation, one row per tour_date
 * (manager-only, mirroring budget_items' flat manager-only visibility —
 * see 0023). "Net to artist" is pre-filled with a suggested computed
 * value (guarantee/ticket revenue minus expenses) but stays editable,
 * since real settlements have manual adjustments a formula won't catch.
 *
 * `settlements` is trigger-bearing (completion-lock), so writes follow
 * the newId()-and-no-.select() convention from lib/ids.ts.
 */
import { useCallback, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { newId } from '../lib/ids';
import { parseOptionalNumber } from '../lib/numbers';
import { logAuditEvent } from '../lib/auditLog';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Settlement'>;

export function SettlementScreen({ route }: Props) {
  const { tourId, tourDateId, tourDateLabel } = route.params;
  const { session } = useAuth();

  const [settlementId, setSettlementId] = useState<string | null>(null);
  const [guarantee, setGuarantee] = useState('');
  const [ticketCount, setTicketCount] = useState('');
  const [ticketPrice, setTicketPrice] = useState('');
  const [expenses, setExpenses] = useState('');
  const [netToArtist, setNetToArtist] = useState('');
  const [netEdited, setNetEdited] = useState(false);
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function load() {
    const { data, error } = await supabase
      .from('settlements')
      .select('id, guarantee, ticket_count, ticket_price, expenses, net_to_artist, notes')
      .eq('tour_date_id', tourDateId)
      .maybeSingle();

    if (error) {
      setErrorMessage(error.message);
      return;
    }
    if (data) {
      setSettlementId(data.id);
      setGuarantee(data.guarantee != null ? String(data.guarantee) : '');
      setTicketCount(data.ticket_count != null ? String(data.ticket_count) : '');
      setTicketPrice(data.ticket_price != null ? String(data.ticket_price) : '');
      setExpenses(data.expenses != null ? String(data.expenses) : '');
      setNetToArtist(data.net_to_artist != null ? String(data.net_to_artist) : '');
      setNotes(data.notes ?? '');
      setNetEdited(data.net_to_artist != null);
    }
  }

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load().finally(() => setLoading(false));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tourDateId])
  );

  // Auto-suggest net-to-artist from the other fields, but only until the
  // person actually edits that field by hand — after that, their number
  // wins, since real settlements have adjustments a formula won't catch.
  function suggestNet(nextGuarantee: string, nextTicketCount: string, nextTicketPrice: string, nextExpenses: string) {
    if (netEdited) return;
    // Only clear the field when every input is actually blank — a
    // genuinely computed $0 (e.g. a comp show) should still show "0.00",
    // not disappear, which `suggested ? ... : ''` would do since 0 is
    // falsy in JS.
    if (![nextGuarantee, nextTicketCount, nextTicketPrice, nextExpenses].some((v) => v.trim())) {
      setNetToArtist('');
      return;
    }
    const g = Number.parseFloat(nextGuarantee) || 0;
    const tc = Number.parseInt(nextTicketCount, 10) || 0;
    const tp = Number.parseFloat(nextTicketPrice) || 0;
    const e = Number.parseFloat(nextExpenses) || 0;
    setNetToArtist((g + tc * tp - e).toFixed(2));
  }

  async function handleSave() {
    if (!session) return;
    setErrorMessage(null);

    let payload: {
      guarantee: number | null;
      ticket_count: number | null;
      ticket_price: number | null;
      expenses: number | null;
      net_to_artist: number | null;
      notes: string | null;
      settled_by: string;
      settled_at: string;
    };
    try {
      payload = {
        guarantee: parseOptionalNumber(guarantee, 'guarantee'),
        ticket_count: parseOptionalNumber(ticketCount, 'ticket count', 'int'),
        ticket_price: parseOptionalNumber(ticketPrice, 'ticket price'),
        expenses: parseOptionalNumber(expenses, 'expenses'),
        net_to_artist: parseOptionalNumber(netToArtist, 'net to artist'),
        notes: notes.trim() || null,
        settled_by: session.user.id,
        settled_at: new Date().toISOString(),
      };
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Invalid number.');
      return;
    }

    setSaving(true);

    const wasExisting = !!settlementId;
    const savedId = settlementId ?? newId();
    let error;
    if (settlementId) {
      ({ error } = await supabase.from('settlements').update(payload).eq('id', settlementId));
    } else {
      ({ error } = await supabase.from('settlements').insert({
        id: savedId,
        tour_date_id: tourDateId,
        created_by: session.user.id,
        ...payload,
      }));
      if (!error) setSettlementId(savedId);
    }

    setSaving(false);
    if (error) {
      setErrorMessage(error.message);
      return;
    }

    logAuditEvent({
      tourId,
      actorId: session.user.id,
      action: wasExisting ? 'update' : 'create',
      resourceType: 'settlement',
      resourceId: savedId,
      detail: { tour_date_id: tourDateId, net_to_artist: payload.net_to_artist },
    });
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Settlement</Text>
      <Text style={styles.subtitle}>{tourDateLabel}</Text>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <View style={styles.row}>
        <Field
          label="Guarantee ($)"
          value={guarantee}
          onChange={(v) => {
            setGuarantee(v);
            suggestNet(v, ticketCount, ticketPrice, expenses);
          }}
        />
        <Field
          label="Ticket count"
          value={ticketCount}
          onChange={(v) => {
            setTicketCount(v);
            suggestNet(guarantee, v, ticketPrice, expenses);
          }}
        />
      </View>
      <View style={styles.row}>
        <Field
          label="Ticket price ($)"
          value={ticketPrice}
          onChange={(v) => {
            setTicketPrice(v);
            suggestNet(guarantee, ticketCount, v, expenses);
          }}
        />
        <Field
          label="Expenses ($)"
          value={expenses}
          onChange={(v) => {
            setExpenses(v);
            suggestNet(guarantee, ticketCount, ticketPrice, v);
          }}
        />
      </View>

      <Text style={styles.fieldLabel}>Net to artist ($)</Text>
      <TextInput
        style={styles.input}
        placeholder="0.00"
        placeholderTextColor="#6b6b76"
        value={netToArtist}
        onChangeText={(v) => {
          setNetToArtist(v);
          setNetEdited(true);
        }}
        keyboardType="decimal-pad"
      />
      <Text style={styles.hint}>Auto-suggested from the fields above until you edit it directly.</Text>

      <Text style={styles.fieldLabel}>Notes</Text>
      <TextInput
        style={[styles.input, styles.notesInput]}
        placeholder="Adjustments, disputes, anything worth remembering"
        placeholderTextColor="#6b6b76"
        value={notes}
        onChangeText={setNotes}
        multiline
      />

      <Pressable style={styles.saveButton} onPress={handleSave} disabled={saving}>
        {saving ? <ActivityIndicator color="#0b0b0f" /> : <Text style={styles.saveButtonText}>Save Settlement</Text>}
      </Pressable>
    </ScrollView>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <View style={styles.fieldFlex}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput style={styles.input} placeholder="0" placeholderTextColor="#6b6b76" value={value} onChangeText={onChange} keyboardType="decimal-pad" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b0f' },
  centered: { flex: 1, backgroundColor: '#0b0b0f', alignItems: 'center', justifyContent: 'center' },
  content: { padding: 20, paddingBottom: 60 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700' },
  subtitle: { color: '#6b6b76', fontSize: 13, marginTop: 4, marginBottom: 16 },
  error: { color: '#ff6b6b', fontSize: 13, marginBottom: 12 },
  row: { flexDirection: 'row', gap: 10 },
  fieldFlex: { flex: 1 },
  fieldLabel: { color: '#9a9aa5', fontSize: 12, marginBottom: 6, marginTop: 8 },
  input: {
    backgroundColor: '#1a1a20',
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    marginBottom: 4,
  },
  notesInput: { minHeight: 80, textAlignVertical: 'top' },
  hint: { color: '#6b6b76', fontSize: 11, marginBottom: 4 },
  saveButton: { backgroundColor: '#fff', borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 20 },
  saveButtonText: { color: '#0b0b0f', fontSize: 16, fontWeight: '600' },
});
