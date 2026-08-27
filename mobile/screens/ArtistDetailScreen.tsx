/**
 * ArtistDetailScreen — the private side of an artist: management
 * contacts, team roster, and any riders/hospitality documents tagged to
 * them. Everything here is gated by "readable by managers or team"
 * policies (0027) — a crew member who isn't on this artist's team and
 * isn't a manager gets an empty read from every one of these queries,
 * not an error, so this screen naturally shows nothing sensitive to
 * someone who shouldn't see it even if they somehow land on it.
 *
 * Adding someone to the team picks from the tour's existing roster
 * (fetchTourRoster) — this doesn't create new accounts, it just marks an
 * existing tour member as "on Artist X's team," which is what flips
 * their visibility into this artist's private data.
 */
import { useCallback, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { fetchTourRoster, type RosterMember } from '../lib/roster';
import { newId } from '../lib/ids';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'ArtistDetail'>;

type Contact = { id: string; name: string; role: string | null; phone: string | null; email: string | null };
type TeamMember = { id: string; user_id: string; role: string | null; profile: { display_name: string } | null };
type Doc = { id: string; title: string; category: string; created_at: string };

const MANAGER_TIERS = new Set(['owner', 'admin', 'manager']);

export function ArtistDetailScreen({ route, navigation }: Props) {
  const { artistId, tourId, artistName } = route.params;
  const { session } = useAuth();

  const [canManage, setCanManage] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [showAddContact, setShowAddContact] = useState(false);
  const [contactName, setContactName] = useState('');
  const [contactRole, setContactRole] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [showAddTeam, setShowAddTeam] = useState(false);
  const [savingContact, setSavingContact] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function load() {
    if (session) {
      const [{ data: roleData }, { data: deptData }] = await Promise.all([
        supabase.rpc('effective_tour_role', { p_tour_id: tourId, p_user_id: session.user.id }),
        supabase.rpc('department_on_tour', { p_tour_id: tourId, p_user_id: session.user.id }),
      ]);
      setCanManage((roleData ? MANAGER_TIERS.has(roleData) : false) || deptData === 'production');
    }

    const [contactsRes, teamRes, docsRes, rosterList] = await Promise.all([
      supabase.from('artist_contacts').select('id, name, role, phone, email').eq('artist_id', artistId),
      // artist_team_members has two FKs into profiles (user_id and
      // added_by) — PostgREST can't auto-pick which one to embed for
      // "profile" without disambiguation, so this names the column
      // explicitly rather than just `profiles(display_name)`.
      supabase.from('artist_team_members').select('id, user_id, role, profile:profiles!artist_team_members_user_id_fkey(display_name)').eq('artist_id', artistId),
      supabase.from('documents').select('id, title, category, created_at').eq('artist_id', artistId).order('created_at', { ascending: false }),
      fetchTourRoster(tourId).catch(() => [] as RosterMember[]),
    ]);

    if (contactsRes.error) setErrorMessage(contactsRes.error.message);
    setContacts(contactsRes.data ?? []);
    if (teamRes.error) setErrorMessage(teamRes.error.message);
    setTeam((teamRes.data ?? []) as unknown as TeamMember[]);
    if (docsRes.error) setErrorMessage(docsRes.error.message);
    setDocs(docsRes.data ?? []);
    setRoster(rosterList);
  }

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load().finally(() => setLoading(false));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [artistId])
  );

  async function handleRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function handleAddContact() {
    if (!contactName.trim()) return;
    setSavingContact(true);
    setErrorMessage(null);
    const { error } = await supabase.from('artist_contacts').insert({
      id: newId(),
      artist_id: artistId,
      name: contactName.trim(),
      role: contactRole.trim() || null,
      phone: contactPhone.trim() || null,
      email: contactEmail.trim() || null,
    });
    setSavingContact(false);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    setContactName('');
    setContactRole('');
    setContactPhone('');
    setContactEmail('');
    setShowAddContact(false);
    await load();
  }

  function confirmDeleteContact(contact: Contact) {
    Alert.alert('Remove this contact?', contact.name, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('artist_contacts').delete().eq('id', contact.id);
          if (error) setErrorMessage(error.message);
          else await load();
        },
      },
    ]);
  }

  async function handleAddTeamMember(userId: string) {
    setErrorMessage(null);
    const { error } = await supabase.from('artist_team_members').insert({
      id: newId(),
      artist_id: artistId,
      user_id: userId,
    });
    if (error) {
      setErrorMessage(error.message.includes('duplicate') ? 'Already on this team.' : error.message);
      return;
    }
    setShowAddTeam(false);
    await load();
  }

  function confirmRemoveTeamMember(member: TeamMember) {
    Alert.alert('Remove from this artist’s team?', member.profile?.display_name ?? 'this person', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('artist_team_members').delete().eq('id', member.id);
          if (error) setErrorMessage(error.message);
          else await load();
        },
      },
    ]);
  }

  const availableRoster = roster.filter((r) => !team.some((t) => t.user_id === r.user_id));

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#fff" />}
    >
      <Text style={styles.title}>{artistName}</Text>
      <Text style={styles.privacyNote}>Visible only to tour management and this artist's own team.</Text>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Management Contacts</Text>
        {canManage && (
          <Pressable onPress={() => setShowAddContact((v) => !v)}>
            <Text style={styles.sectionAction}>{showAddContact ? 'Cancel' : '+ Add'}</Text>
          </Pressable>
        )}
      </View>
      {showAddContact && (
        <View style={styles.addCard}>
          <TextInput style={styles.input} placeholder="Name" placeholderTextColor="#6b6b76" value={contactName} onChangeText={setContactName} />
          <TextInput style={styles.input} placeholder="Role (Tour Manager, Agent...)" placeholderTextColor="#6b6b76" value={contactRole} onChangeText={setContactRole} />
          <View style={styles.row}>
            <TextInput style={[styles.input, styles.rowInput]} placeholder="Phone" placeholderTextColor="#6b6b76" value={contactPhone} onChangeText={setContactPhone} keyboardType="phone-pad" />
            <TextInput style={[styles.input, styles.rowInput]} placeholder="Email" placeholderTextColor="#6b6b76" value={contactEmail} onChangeText={setContactEmail} autoCapitalize="none" keyboardType="email-address" />
          </View>
          <Pressable style={styles.saveButton} onPress={handleAddContact} disabled={savingContact || !contactName.trim()}>
            {savingContact ? <ActivityIndicator color="#0b0b0f" /> : <Text style={styles.saveButtonText}>Save Contact</Text>}
          </Pressable>
        </View>
      )}
      {contacts.length === 0 && !showAddContact && <Text style={styles.emptyText}>No contacts on file.</Text>}
      {contacts.map((c) => (
        <Pressable key={c.id} style={styles.card} onLongPress={canManage ? () => confirmDeleteContact(c) : undefined}>
          <Text style={styles.contactName}>{c.name}</Text>
          {c.role && <Text style={styles.contactRole}>{c.role}</Text>}
          {c.phone && (
            <Pressable onPress={() => Linking.openURL(`tel:${c.phone}`)}>
              <Text style={styles.contactLink}>{c.phone}</Text>
            </Pressable>
          )}
          {c.email && (
            <Pressable onPress={() => Linking.openURL(`mailto:${c.email}`)}>
              <Text style={styles.contactLink}>{c.email}</Text>
            </Pressable>
          )}
        </Pressable>
      ))}

      <View style={[styles.sectionHeader, styles.sectionSpaced]}>
        <Text style={styles.sectionTitle}>Team</Text>
        {canManage && (
          <Pressable onPress={() => setShowAddTeam((v) => !v)}>
            <Text style={styles.sectionAction}>{showAddTeam ? 'Cancel' : '+ Add'}</Text>
          </Pressable>
        )}
      </View>
      {showAddTeam && (
        <View style={styles.addCard}>
          {availableRoster.length === 0 ? (
            <Text style={styles.emptyText}>Everyone on the roster is already on a team, or there's no one to add yet.</Text>
          ) : (
            availableRoster.map((r) => (
              <Pressable key={r.user_id} style={styles.rosterRow} onPress={() => handleAddTeamMember(r.user_id)}>
                <Text style={styles.rosterName}>{r.display_name}</Text>
                <Text style={styles.rosterAdd}>+ Add</Text>
              </Pressable>
            ))
          )}
        </View>
      )}
      {team.length === 0 && !showAddTeam && <Text style={styles.emptyText}>No one assigned yet.</Text>}
      {team.map((m) => (
        <Pressable key={m.id} style={styles.card} onLongPress={canManage ? () => confirmRemoveTeamMember(m) : undefined}>
          <Text style={styles.contactName}>{m.profile?.display_name ?? 'Unknown'}</Text>
          {m.role && <Text style={styles.contactRole}>{m.role}</Text>}
        </Pressable>
      ))}
      {canManage && team.length > 0 && <Text style={styles.hint}>Hold a name to remove them from this team.</Text>}

      <View style={[styles.sectionHeader, styles.sectionSpaced]}>
        <Text style={styles.sectionTitle}>Riders & Hospitality</Text>
        {canManage && (
          <Pressable onPress={() => navigation.navigate('AddDocument', { tourId })}>
            <Text style={styles.sectionAction}>+ Upload</Text>
          </Pressable>
        )}
      </View>
      {docs.length === 0 && <Text style={styles.emptyText}>No documents tagged to this artist yet.</Text>}
      {docs.map((d) => (
        <View key={d.id} style={styles.card}>
          <Text style={styles.contactName}>{d.title}</Text>
          <Text style={styles.contactRole}>{d.category}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b0f' },
  centered: { flex: 1, backgroundColor: '#0b0b0f', alignItems: 'center', justifyContent: 'center' },
  content: { padding: 20, paddingBottom: 60 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700' },
  privacyNote: { color: '#6b6b76', fontSize: 12, marginTop: 4, marginBottom: 16, fontStyle: 'italic' },
  error: { color: '#ff6b6b', fontSize: 13, marginBottom: 12 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  sectionSpaced: { marginTop: 20 },
  sectionTitle: { color: '#9a9aa5', fontSize: 12, fontWeight: '600', textTransform: 'uppercase' },
  sectionAction: { color: '#7c9cff', fontSize: 13, fontWeight: '600' },
  emptyText: { color: '#6b6b76', fontSize: 13, marginBottom: 8 },
  addCard: { backgroundColor: '#15151a', borderRadius: 12, padding: 14, marginBottom: 10 },
  input: {
    backgroundColor: '#1a1a20',
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
    fontSize: 14,
  },
  row: { flexDirection: 'row', gap: 8 },
  rowInput: { flex: 1 },
  saveButton: { backgroundColor: '#fff', borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 4 },
  saveButtonText: { color: '#0b0b0f', fontSize: 14, fontWeight: '600' },
  card: { backgroundColor: '#1a1a20', borderRadius: 10, padding: 14, marginBottom: 8 },
  contactName: { color: '#fff', fontSize: 14, fontWeight: '600' },
  contactRole: { color: '#9a9aa5', fontSize: 12, marginTop: 2 },
  contactLink: { color: '#7c9cff', fontSize: 13, marginTop: 4 },
  rosterRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#1a1a20',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 6,
  },
  rosterName: { color: '#fff', fontSize: 14 },
  rosterAdd: { color: '#7c9cff', fontSize: 13, fontWeight: '600' },
  hint: { color: '#6b6b76', fontSize: 12, textAlign: 'center', marginTop: 4 },
});
