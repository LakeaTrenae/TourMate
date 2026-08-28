/**
 * DirectoryScreen — the full tour contact directory, open to every tour
 * member (not just managers, unlike ManageTeamScreen which also has the
 * remove/invite controls). Read-only here on purpose: this screen answers
 * "who is X and how do I reach them," not "let me edit the roster."
 *
 * Grouped by department so "who is security" (or travel, or production)
 * is a glance, not a search — same tour_members + profiles query every
 * other roster view in the app already uses, gated the same way by
 * "tour_members readable by fellow tour members" (0002_policy_gaps.sql)
 * and "profiles readable by fellow tour or org members" (0011).
 */
import { useCallback, useMemo, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import {
  ActivityIndicator,
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
import { formatRole, formatDepartment } from '../lib/format';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Directory'>;

const MANAGER_TIERS = new Set(['owner', 'admin', 'manager']);

type Person = {
  user_id: string;
  role: string;
  department: string;
  profile: { display_name: string; phone: string | null; email: string } | null;
};

// Fixed display order — matches the tour_department enum in the DB
// (0003_departments_and_sharing.sql, extended with 'security' in 0021).
const DEPARTMENT_ORDER = [
  'tour_management',
  'production',
  'security',
  'travel',
  'artist_relations',
  'finance',
  'general',
];

export function DirectoryScreen({ route, navigation }: Props) {
  const { tourId, tourName } = route.params;
  const { session } = useAuth();

  const [people, setPeople] = useState<Person[]>([]);
  const [isManager, setIsManager] = useState(false);
  const [search, setSearch] = useState('');
  const [activeDepartment, setActiveDepartment] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function load() {
    if (session) {
      const { data: roleData } = await supabase.rpc('effective_tour_role', {
        p_tour_id: tourId,
        p_user_id: session.user.id,
      });
      setIsManager(roleData ? MANAGER_TIERS.has(roleData) : false);
    }

    const { data, error } = await supabase
      .from('tour_members')
      .select('user_id, role, department, profile:profiles(display_name, phone, email)')
      .eq('tour_id', tourId);
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    setPeople((data ?? []) as unknown as Person[]);
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

  const presentDepartments = useMemo(() => {
    const present = new Set(people.map((p) => p.department));
    return DEPARTMENT_ORDER.filter((d) => present.has(d));
  }, [people]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return people.filter((p) => {
      if (activeDepartment && p.department !== activeDepartment) return false;
      if (!q) return true;
      const name = p.profile?.display_name?.toLowerCase() ?? '';
      const email = p.profile?.email?.toLowerCase() ?? '';
      return name.includes(q) || email.includes(q);
    });
  }, [people, search, activeDepartment]);

  const grouped = useMemo(() => {
    const groups: { department: string; people: Person[] }[] = [];
    for (const dept of DEPARTMENT_ORDER) {
      const inDept = filtered.filter((p) => p.department === dept);
      if (inDept.length > 0) groups.push({ department: dept, people: inDept });
    }
    return groups;
  }, [filtered]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Directory</Text>
        <Text style={styles.subtitle}>{tourName}</Text>
      </View>

      <TextInput
        style={styles.search}
        placeholder="Search name or email"
        placeholderTextColor="#6b6b76"
        value={search}
        onChangeText={setSearch}
        autoCapitalize="none"
      />

      {(presentDepartments.length > 1 || activeDepartment) && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow} contentContainerStyle={styles.chipRowContent}>
          <Pressable
            style={[styles.chip, activeDepartment === null && styles.chipActive]}
            onPress={() => setActiveDepartment(null)}
          >
            <Text style={[styles.chipText, activeDepartment === null && styles.chipTextActive]}>All</Text>
          </Pressable>
          {presentDepartments.map((dept) => (
            <Pressable
              key={dept}
              style={[styles.chip, activeDepartment === dept && styles.chipActive]}
              onPress={() => setActiveDepartment(dept)}
            >
              <Text style={[styles.chipText, activeDepartment === dept && styles.chipTextActive]}>
                {formatDepartment(dept)}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#fff" />}
        contentContainerStyle={grouped.length === 0 && styles.emptyContainer}
      >
        {grouped.length === 0 ? (
          <Text style={styles.emptyText}>{search ? 'No one matches that search.' : 'No one on the roster yet.'}</Text>
        ) : (
          grouped.map((group) => (
            <View key={group.department} style={styles.group}>
              <Text style={styles.groupTitle}>{formatDepartment(group.department)}</Text>
              {group.people.map((p) => (
                <View key={p.user_id} style={styles.card}>
                  <Text style={styles.name}>{p.profile?.display_name ?? 'Unknown'}</Text>
                  <Text style={styles.role}>{formatRole(p.role)}</Text>
                  {p.profile?.phone && (
                    <Pressable onPress={() => Linking.openURL(`tel:${p.profile!.phone}`)}>
                      <Text style={styles.contactLink}>{p.profile.phone}</Text>
                    </Pressable>
                  )}
                  {p.profile?.email && (
                    <Pressable onPress={() => Linking.openURL(`mailto:${p.profile!.email}`)}>
                      <Text style={styles.contactLink}>{p.profile.email}</Text>
                    </Pressable>
                  )}
                  {isManager && (
                    <Pressable
                      onPress={() =>
                        navigation.navigate('PassportVisa', {
                          targetUserId: p.user_id,
                          targetName: p.profile?.display_name ?? undefined,
                        })
                      }
                    >
                      <Text style={styles.passportLink}>Passport & Visa ›</Text>
                    </Pressable>
                  )}
                  {isManager && (
                    <Pressable
                      onPress={() =>
                        navigation.navigate('EmergencyContact', {
                          targetUserId: p.user_id,
                          targetName: p.profile?.display_name ?? undefined,
                        })
                      }
                    >
                      <Text style={styles.passportLink}>Emergency Contact ›</Text>
                    </Pressable>
                  )}
                </View>
              ))}
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b0f', paddingTop: 20, paddingHorizontal: 20 },
  centered: { flex: 1, backgroundColor: '#0b0b0f', alignItems: 'center', justifyContent: 'center' },
  header: { marginBottom: 12 },
  title: { color: '#fff', fontSize: 24, fontWeight: '700' },
  subtitle: { color: '#6b6b76', fontSize: 13, marginTop: 2 },
  search: {
    backgroundColor: '#1a1a20',
    color: '#fff',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    marginBottom: 10,
  },
  chipRow: { flexGrow: 0, marginBottom: 12 },
  chipRowContent: { gap: 8, paddingRight: 8 },
  chip: {
    backgroundColor: '#1a1a20',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  chipActive: { backgroundColor: '#fff' },
  chipText: { color: '#9a9aa5', fontSize: 12, fontWeight: '600' },
  chipTextActive: { color: '#0b0b0f' },
  error: { color: '#ff6b6b', fontSize: 13, marginBottom: 12 },
  emptyContainer: { flexGrow: 1, justifyContent: 'center' },
  emptyText: { color: '#6b6b76', fontSize: 14, textAlign: 'center' },
  group: { marginBottom: 18 },
  groupTitle: {
    color: '#9a9aa5',
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  card: {
    backgroundColor: '#1a1a20',
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
  },
  name: { color: '#fff', fontSize: 15, fontWeight: '600' },
  role: { color: '#6b6b76', fontSize: 12, marginTop: 2 },
  contactLink: { color: '#7c9cff', fontSize: 13, marginTop: 4 },
  passportLink: { color: '#9a9aa5', fontSize: 12, marginTop: 6 },
});
