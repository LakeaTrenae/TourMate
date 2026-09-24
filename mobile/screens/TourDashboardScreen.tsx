/**
 * TourDashboardScreen — the per-tour home screen, scoped to whatever the
 * signed-in user is actually allowed to see and do.
 *
 * Schedule and People are rendered inline here; Travel, Lodging, Guest
 * List, Documents, and Budget are their own screens, linked from the
 * "More" section below.
 *
 * Nothing in this screen manually checks "is this person a manager" to
 * decide what data to fetch — the query is the same for everyone, and
 * Postgres RLS decides what actually comes back. The only role-awareness
 * here is UI-level: hiding the Budget entry point for non-managers so
 * crew aren't shown a dead end, not enforcing the restriction (RLS
 * already does that even if this check were somehow bypassed).
 *
 * Theme (Manrope/JetBrains Mono, navy accent) per the "Load-In" design
 * review — see lib/theme.tsx. Section/NavRow are module-level helpers,
 * so they take the computed `styles` as a prop rather than closing over
 * a module-level StyleSheet the way the pre-theme version did.
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
  View,
} from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { formatDateOnly } from '../lib/dates';
import { formatRole, formatDepartment } from '../lib/format';
import { newId } from '../lib/ids';
import { buildTourIcs } from '../lib/ics';
import { useCachedLoad } from '../lib/useCachedLoad';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'TourDashboard'>;

type TourDate = { id: string; date: string };
type ScheduleItem = {
  id: string;
  tour_date_id: string;
  department: string;
  title: string;
  start_time: string | null;
  location: string | null;
};
type TourMemberRow = {
  user_id: string;
  role: 'owner' | 'admin' | 'manager' | 'crew';
  department: string;
  profile: { display_name: string; phone: string | null; email: string } | null;
};

const MANAGER_TIERS = new Set(['owner', 'admin', 'manager']);

type DashboardData = {
  effectiveRole: string | null;
  department: string | null;
  completedAt: string | null;
  scheduleByDate: { id: string; date: string; items: ScheduleItem[] }[];
  members: TourMemberRow[];
};

type Styles = ReturnType<typeof createStyles>;

export function TourDashboardScreen({ route, navigation }: Props) {
  const { tourId, tourName } = route.params;
  const { session } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // Wrapped in useCachedLoad — the tour dashboard is the screen a
  // returning user lands on immediately after opening a tour, so it's
  // one of the two screens (with TourList) where showing last-synced
  // data offline instead of a blank/error screen matters most. If any
  // piece of this fails, the whole fetch throws — the fallback is "last
  // known good full dashboard," not a partial mix of fresh and stale.
  const fetchDashboard = useCallback(async (): Promise<DashboardData> => {
    if (!session) throw new Error('Not signed in.');
    const userId = session.user.id;

    // effective_tour_role / department_on_tour are the same SQL functions
    // the RLS policies themselves use (0001 + 0003) — calling them via RPC
    // means the UI's notion of "what am I" can never drift out of sync
    // with what the database will actually enforce.
    const [{ data: roleData, error: roleError }, { data: deptData, error: deptError }] = await Promise.all([
      supabase.rpc('effective_tour_role', { p_tour_id: tourId, p_user_id: userId }),
      supabase.rpc('department_on_tour', { p_tour_id: tourId, p_user_id: userId }),
    ]);
    if (roleError) throw roleError;
    if (deptError) throw deptError;

    const { data: tourRow, error: tourError } = await supabase
      .from('tours')
      .select('completed_at')
      .eq('id', tourId)
      .single();
    if (tourError) throw tourError;

    // Schedule: fetch this tour's dates, then the schedule items under
    // them. RLS (can_view_schedule_item) already filters items down to
    // "visible to all", "my department", "I'm a manager", or "explicitly
    // shared with me" — no filtering needed here.
    const { data: dates, error: datesError } = await supabase
      .from('tour_dates')
      .select('id, date')
      .eq('tour_id', tourId)
      .order('date', { ascending: true });
    if (datesError) throw datesError;

    const dateIds = (dates ?? []).map((d: TourDate) => d.id);
    let items: ScheduleItem[] = [];
    if (dateIds.length > 0) {
      const { data: itemRows, error: itemsError } = await supabase
        .from('schedule_items')
        .select('id, tour_date_id, department, title, start_time, location')
        .in('tour_date_id', dateIds)
        .order('start_time', { ascending: true });
      if (itemsError) throw itemsError;
      items = itemRows ?? [];
    }

    // People directory — the tour roster. Relies on the "profiles
    // readable by fellow tour or org members" policy from 0004.
    const { data: memberRows, error: membersError } = await supabase
      .from('tour_members')
      .select('user_id, role, department, profile:profiles(display_name, phone, email)')
      .eq('tour_id', tourId);
    if (membersError) throw membersError;

    return {
      effectiveRole: roleData ?? null,
      department: deptData ?? null,
      completedAt: tourRow?.completed_at ?? null,
      scheduleByDate: (dates ?? []).map((d: TourDate) => ({
        id: d.id,
        date: d.date,
        items: items.filter((i) => i.tour_date_id === d.id),
      })),
      members: (memberRows ?? []) as unknown as TourMemberRow[],
    };
  }, [tourId, session]);

  const { data: dashboard, loading, isOffline, refresh } = useCachedLoad(`tour-dashboard:${tourId}`, fetchDashboard);

  const effectiveRole = dashboard?.effectiveRole ?? null;
  const department = dashboard?.department ?? null;
  const completedAt = dashboard?.completedAt ?? null;
  const scheduleByDate = dashboard?.scheduleByDate ?? [];
  const members = dashboard?.members ?? [];

  const isManager = useMemo(() => (effectiveRole ? MANAGER_TIERS.has(effectiveRole) : false), [effectiveRole]);
  const isTourOwner = effectiveRole === 'owner';

  useFocusEffect(
    useCallback(() => {
      refresh().catch((err) => setErrorMessage(err instanceof Error ? err.message : 'Failed to load this tour.'));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tourId])
  );

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await refresh();
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to load this tour.');
    }
    setRefreshing(false);
  }

  // Any tour member can export — this just re-delivers their own
  // already-RLS-filtered schedule view as a file, not a new visibility
  // grant (see "tour exports readable/writable by tour members",
  // 0023_ground_transport_advancing_settlement.sql).
  async function handleExportCalendar() {
    setErrorMessage(null);
    setExporting(true);
    try {
      const { data: dateRows, error: dateError } = await supabase
        .from('tour_dates')
        .select('id, date, load_in, doors, set_time, venue:venues(name, city)')
        .eq('tour_id', tourId)
        .order('date', { ascending: true });
      if (dateError) throw dateError;

      const shows = ((dateRows ?? []) as unknown as Array<{
        id: string;
        date: string;
        load_in: string | null;
        doors: string | null;
        set_time: string | null;
        venue: { name: string; city: string | null } | null;
      }>).map((d) => ({
        id: d.id,
        date: d.date,
        venueName: d.venue?.name ?? null,
        city: d.venue?.city ?? null,
        loadIn: d.load_in,
        doors: d.doors,
        setTime: d.set_time,
      }));

      if (shows.length === 0) {
        setErrorMessage('No show dates yet to export.');
        return;
      }

      const icsText = buildTourIcs(tourName, shows);
      const path = `${tourId}/${newId()}.ics`;
      const { error: uploadError } = await supabase.storage
        .from('tour-exports')
        .upload(path, icsText, { contentType: 'text/calendar', upsert: true });
      if (uploadError) throw uploadError;

      const { data: signedUrlData, error: signError } = await supabase.storage
        .from('tour-exports')
        .createSignedUrl(path, 60 * 5);
      if (signError || !signedUrlData) throw signError ?? new Error('Failed to create download link.');

      Linking.openURL(signedUrlData.signedUrl);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to export calendar.');
    } finally {
      setExporting(false);
    }
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
      <Text style={styles.tourName}>{tourName}</Text>
      {effectiveRole && (
        <Text style={styles.roleBadge}>
          {formatRole(effectiveRole)} · {formatDepartment(department)}
        </Text>
      )}

      {completedAt && (
        <View style={styles.lockBanner}>
          <Text style={styles.lockBannerText}>
            This tour was completed on{' '}
            {new Date(completedAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}
            {' — '}
            {isTourOwner
              ? 'as the tour owner, you can still make changes.'
              : "it's read-only now. Contact the tour owner if something needs fixing."}
          </Text>
        </View>
      )}

      {isOffline && <Text style={styles.offlineBanner}>You're offline — showing last synced data.</Text>}
      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <Section
        title="Schedule"
        styles={styles}
        action={
          <View style={styles.sectionActionRow}>
            <Pressable onPress={handleExportCalendar} disabled={exporting}>
              <Text style={styles.sectionAction}>{exporting ? 'Exporting…' : 'Export'}</Text>
            </Pressable>
            {isManager && (
              <>
                <Pressable onPress={() => navigation.navigate('ImportSchedule', { tourId })}>
                  <Text style={styles.sectionAction}>Import</Text>
                </Pressable>
                <Pressable onPress={() => navigation.navigate('AddTourDate', { tourId })}>
                  <Text style={styles.sectionAction}>+ Date</Text>
                </Pressable>
              </>
            )}
          </View>
        }
      >
        {scheduleByDate.length === 0 && <Text style={styles.emptyText}>No dates added yet.</Text>}
        {scheduleByDate.map((day) => (
          <View key={day.id} style={styles.dayGroup}>
            <Pressable onPress={() => navigation.navigate('ShowDetail', { tourId, tourDateId: day.id })}>
              <Text style={styles.dayLabel}>
                {formatDateOnly(day.date, { weekday: 'short', month: 'short', day: 'numeric' })} ›
              </Text>
            </Pressable>
            {day.items.length === 0 ? (
              <Text style={styles.emptyText}>Nothing visible to you on this date.</Text>
            ) : (
              day.items.map((item) => (
                <View key={item.id} style={styles.scheduleRow}>
                  <Text style={styles.scheduleTime}>{item.start_time?.slice(0, 5) ?? '--:--'}</Text>
                  <View style={styles.scheduleInfo}>
                    <Text style={styles.scheduleTitle}>{item.title}</Text>
                    <Text style={styles.scheduleMeta}>
                      {formatDepartment(item.department)}
                      {item.location ? ` · ${item.location}` : ''}
                    </Text>
                  </View>
                </View>
              ))
            )}
          </View>
        ))}
      </Section>

      <Section
        title="People"
        styles={styles}
        action={
          <View style={styles.sectionActionRow}>
            <Pressable onPress={() => navigation.navigate('Directory', { tourId, tourName })}>
              <Text style={styles.sectionAction}>Directory</Text>
            </Pressable>
            {isManager && (
              <Pressable onPress={() => navigation.navigate('ManageTeam', { tourId, tourName })}>
                <Text style={styles.sectionAction}>Manage</Text>
              </Pressable>
            )}
          </View>
        }
      >
        {members.length === 0 && <Text style={styles.emptyText}>No one on the roster yet.</Text>}
        {members.slice(0, 5).map((m) => (
          <View key={m.user_id} style={styles.personRow}>
            <Text style={styles.personName}>{m.profile?.display_name ?? 'Unknown'}</Text>
            <Text style={styles.personMeta}>
              {formatRole(m.role)} · {formatDepartment(m.department)}
            </Text>
            {m.profile?.phone && (
              <Pressable onPress={() => Linking.openURL(`tel:${m.profile!.phone}`)}>
                <Text style={styles.personContactLink}>{m.profile.phone}</Text>
              </Pressable>
            )}
            {m.profile?.email && (
              <Pressable onPress={() => Linking.openURL(`mailto:${m.profile!.email}`)}>
                <Text style={styles.personContactLink}>{m.profile.email}</Text>
              </Pressable>
            )}
          </View>
        ))}
        {members.length > 5 && (
          <Pressable onPress={() => navigation.navigate('Directory', { tourId, tourName })}>
            <Text style={styles.seeAllText}>See all {members.length} in Directory →</Text>
          </Pressable>
        )}
      </Section>

      <Section title="More" styles={styles}>
        <NavRow styles={styles} label="Directory" onPress={() => navigation.navigate('Directory', { tourId, tourName })} />
        <NavRow styles={styles} label="Artists" onPress={() => navigation.navigate('Artists', { tourId, tourName })} />
        <NavRow styles={styles} label="Travel" onPress={() => navigation.navigate('Travel', { tourId, tourName })} />
        <NavRow styles={styles} label="Ground Transport" onPress={() => navigation.navigate('GroundTransport', { tourId, tourName })} />
        <NavRow styles={styles} label="Route" onPress={() => navigation.navigate('Route', { tourId, tourName })} />
        <NavRow styles={styles} label="Lodging" onPress={() => navigation.navigate('Lodging', { tourId, tourName })} />
        <NavRow styles={styles} label="Guest List" onPress={() => navigation.navigate('GuestList', { tourId, tourName })} />
        <NavRow styles={styles} label="Documents" onPress={() => navigation.navigate('Documents', { tourId, tourName })} />
        <NavRow styles={styles} label="Checklists" onPress={() => navigation.navigate('Checklists', { tourId, tourName })} />
        <NavRow styles={styles} label="Set Lists" onPress={() => navigation.navigate('SetLists', { tourId, tourName })} />
        <NavRow styles={styles} label="Full Tour Export" onPress={() => navigation.navigate('TourExport', { tourId, tourName })} />
        <NavRow styles={styles} label="Import Data" onPress={() => navigation.navigate('Import', { tourId, tourName })} />
        {isManager && <NavRow styles={styles} label="Budget" onPress={() => navigation.navigate('Budget', { tourId, tourName })} />}
        {isManager && <NavRow styles={styles} label="Activity Log" onPress={() => navigation.navigate('AuditLog', { tourId, tourName })} />}
      </Section>
    </ScrollView>
  );
}

function Section({
  title,
  action,
  children,
  styles,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  styles: Styles;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {action}
      </View>
      {children}
    </View>
  );
}

function NavRow({ label, onPress, styles }: { label: string; onPress: () => void; styles: Styles }) {
  return (
    <Pressable style={styles.stubRow} onPress={onPress}>
      <Text style={styles.stubLabel}>{label}</Text>
      <Text style={styles.navArrow}>›</Text>
    </Pressable>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.bg,
    },
    centered: {
      flex: 1,
      backgroundColor: colors.bg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    content: {
      paddingTop: 60,
      paddingHorizontal: 20,
      paddingBottom: 40,
    },
    tourName: {
      color: colors.text,
      fontSize: 26,
      fontFamily: fonts.displayBlack,
      letterSpacing: -0.4,
    },
    roleBadge: {
      color: colors.textDim,
      fontSize: 13,
      marginTop: 4,
      marginBottom: 20,
      fontFamily: fonts.body,
    },
    error: {
      color: colors.danger,
      fontSize: 13,
      marginBottom: 12,
      fontFamily: fonts.body,
    },
    offlineBanner: {
      color: colors.warn,
      fontSize: 12,
      marginBottom: 12,
      textAlign: 'center',
      fontFamily: fonts.body,
    },
    lockBanner: {
      backgroundColor: colors.warnSoft,
      borderRadius: 10,
      padding: 12,
      marginBottom: 16,
    },
    lockBannerText: {
      color: colors.warn,
      fontSize: 13,
      lineHeight: 18,
      fontFamily: fonts.body,
    },
    emptyText: {
      color: colors.textFaint,
      fontSize: 13,
      fontFamily: fonts.body,
    },
    section: {
      marginBottom: 28,
    },
    sectionHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 10,
    },
    sectionTitle: {
      color: colors.text,
      fontSize: 16,
      fontFamily: fonts.displaySemiBold,
    },
    sectionActionRow: {
      flexDirection: 'row',
      gap: 16,
    },
    sectionAction: {
      color: colors.accent,
      fontSize: 13,
      fontFamily: fonts.bodySemiBold,
    },
    dayGroup: {
      marginBottom: 14,
    },
    dayLabel: {
      color: colors.textDim,
      fontSize: 13,
      fontFamily: fonts.bodySemiBold,
      marginBottom: 6,
    },
    scheduleRow: {
      flexDirection: 'row',
      backgroundColor: colors.surface,
      borderRadius: 10,
      padding: 12,
      marginBottom: 6,
    },
    scheduleTime: {
      color: colors.text,
      fontSize: 13,
      fontFamily: fonts.monoMedium,
      width: 52,
    },
    scheduleInfo: {
      flex: 1,
    },
    scheduleTitle: {
      color: colors.text,
      fontSize: 14,
      fontFamily: fonts.body,
    },
    scheduleMeta: {
      color: colors.textFaint,
      fontSize: 12,
      marginTop: 2,
      fontFamily: fonts.body,
    },
    personRow: {
      backgroundColor: colors.surface,
      borderRadius: 10,
      padding: 12,
      marginBottom: 6,
    },
    personName: {
      color: colors.text,
      fontSize: 14,
      fontFamily: fonts.bodySemiBold,
    },
    personMeta: {
      color: colors.textDim,
      fontSize: 12,
      marginTop: 2,
      fontFamily: fonts.body,
    },
    personContactLink: {
      color: colors.accent,
      fontSize: 12,
      marginTop: 2,
      fontFamily: fonts.body,
    },
    seeAllText: {
      color: colors.accent,
      fontSize: 13,
      fontFamily: fonts.bodySemiBold,
      marginTop: 6,
    },
    stubRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      backgroundColor: colors.surface,
      borderRadius: 10,
      padding: 12,
      marginBottom: 6,
    },
    stubLabel: {
      color: colors.text,
      fontSize: 14,
      fontFamily: fonts.body,
    },
    navArrow: {
      color: colors.textFaint,
      fontSize: 18,
    },
  });
}
