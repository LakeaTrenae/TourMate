/**
 * AdvanceScreen — one structured advance sheet per show date, modeled
 * directly on a real touring advance sheet: key contacts, vendors, venue
 * staff, local crew call, the day's running order, power/stage/rigging
 * specs, a production-requirements checklist, headcounts, itemized
 * hospitality by group, meal times, room assignments, and sign-off.
 * Loads-or-creates on first visit (upsert on tour_date_id, which is
 * unique) rather than requiring a separate "start an advance" step.
 *
 * Two save rhythms, matching ArtistDetailScreen's contacts/team-roster
 * split: the advance's own scalar/jsonb fields (status, department,
 * visibility, power, stage specs, etc.) only save when you tap "Save
 * Advance"; every child-table row (contacts, crew labor, hospitality
 * items, room assignments, schedule items) saves immediately on add,
 * exactly like ArtistDetailScreen's contact list. Child rows all require
 * an advanceId first — "Save once first, then come back" is the same
 * gate AdvanceSharing already uses. Schedule items are the one exception:
 * they key off tourDateId directly (the existing schedule_items table,
 * 0003_departments_and_sharing.sql — the same one TourDashboardScreen
 * reads from), so they're addable before the advance itself is saved.
 *
 * `advances` is a trigger-bearing table (completion-lock), so writes
 * follow the newId()-and-no-.select() convention from lib/ids.ts.
 *
 * Theme (Manrope/JetBrains Mono, navy accent) per the "Load-In" design
 * review — see lib/theme.tsx.
 */
import { useCallback, useMemo, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import * as Print from 'expo-print';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { newId } from '../lib/ids';
import { formatDepartment } from '../lib/format';
import { buildAdvanceSheetHtml } from '../lib/dayPrint';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Advance'>;
type Styles = ReturnType<typeof createStyles>;

type Status = 'not_started' | 'in_progress' | 'confirmed';
const STATUSES: { value: Status; label: string }[] = [
  { value: 'not_started', label: 'Not started' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'confirmed', label: 'Confirmed' },
];
const DEPARTMENTS = ['tour_management', 'production', 'security', 'travel', 'artist_relations', 'finance', 'general'];
// Same base concept as AddChecklistScreen: visible_to_all only stores
// true/false, so 'specific' is a UI-level distinction, not a stored
// value — detected here by whether any resource_shares rows exist yet.
type Visibility = 'department' | 'org' | 'specific';

type Person = { id: string; name: string; role: string | null; phone: string | null; email: string | null };
type LaborRow = { id: string; role: string; call_time: string | null; count: number | null };
type HospitalityRow = {
  id: string;
  group_name: string;
  item: string;
  quantity: string | null;
  notes: string | null;
  fulfilled: boolean;
};
type RoomRow = { id: string; room_label: string; assigned_to: string | null; notes: string | null };
type ScheduleRow = { id: string; start_time: string | null; title: string; location: string | null };

const HOSPITALITY_GROUPS = ['Headliner', 'Support', 'Production', 'Catering', 'SUVs', 'Promoter', 'Runners', 'Other'];

export function AdvanceScreen({ route }: Props) {
  const { tourId, tourDateId, tourDateLabel } = route.params;
  const { session } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [advanceId, setAdvanceId] = useState<string | null>(null);
  const [department, setDepartment] = useState('production');
  const [visibility, setVisibility] = useState<Visibility>('org');
  const [status, setStatus] = useState<Status>('not_started');

  const [power, setPower] = useState<Record<string, string>>({});
  const [stageSpecs, setStageSpecs] = useState<Record<string, string>>({});
  const [productionRequirements, setProductionRequirements] = useState<Record<string, string>>({});
  const [equipmentNeeds, setEquipmentNeeds] = useState<Record<string, string>>({});
  const [headcounts, setHeadcounts] = useState<Record<string, string>>({});
  const [mealTimes, setMealTimes] = useState<Record<string, string>>({});
  const [mealNotes, setMealNotes] = useState('');
  const [signOff, setSignOff] = useState<Record<string, string>>({});
  const [scheduleNotes, setScheduleNotes] = useState('');
  const [parkingNotes, setParkingNotes] = useState('');
  const [securityNotes, setSecurityNotes] = useState('');
  const [otherNotes, setOtherNotes] = useState('');

  const [headliner, setHeadliner] = useState('');
  const [venueName, setVenueName] = useState<string | null>(null);
  const [city, setCity] = useState<string | null>(null);

  const [keyContacts, setKeyContacts] = useState<Person[]>([]);
  const [vendors, setVendors] = useState<Person[]>([]);
  const [venueStaff, setVenueStaff] = useState<Person[]>([]);
  const [crewLabor, setCrewLabor] = useState<LaborRow[]>([]);
  const [hospitalityItems, setHospitalityItems] = useState<HospitalityRow[]>([]);
  const [roomAssignments, setRoomAssignments] = useState<RoomRow[]>([]);
  const [scheduleItems, setScheduleItems] = useState<ScheduleRow[]>([]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function load() {
    const [advanceRes, showRes, scheduleRes] = await Promise.all([
      supabase
        .from('advances')
        .select(
          'id, department, visible_to_all, status, power, stage_specs, production_requirements, equipment_needs, headcounts, meal_times, meal_notes, sign_off, schedule_notes, parking_notes, security_notes, other_notes'
        )
        .eq('tour_date_id', tourDateId)
        .maybeSingle(),
      supabase
        .from('tour_dates')
        .select('venue:venues(name, city), tour:tours(name)')
        .eq('id', tourDateId)
        .single(),
      supabase
        .from('schedule_items')
        .select('id, start_time, title, location')
        .eq('tour_date_id', tourDateId)
        .order('start_time', { ascending: true }),
    ]);

    if (showRes.data) {
      const show = showRes.data as unknown as { venue: { name: string; city: string | null } | null; tour: { name: string } | null };
      setHeadliner(show.tour?.name ?? '');
      setVenueName(show.venue?.name ?? null);
      setCity(show.venue?.city ?? null);
    }
    setScheduleItems((scheduleRes.data ?? []) as ScheduleRow[]);

    if (advanceRes.error) {
      setErrorMessage(advanceRes.error.message);
      return;
    }
    const data = advanceRes.data;
    if (!data) return;

    setAdvanceId(data.id);
    setDepartment(data.department);
    setStatus(data.status);
    setPower((data.power as Record<string, string>) ?? {});
    setStageSpecs((data.stage_specs as Record<string, string>) ?? {});
    setProductionRequirements((data.production_requirements as Record<string, string>) ?? {});
    setEquipmentNeeds((data.equipment_needs as Record<string, string>) ?? {});
    setHeadcounts((data.headcounts as Record<string, string>) ?? {});
    setMealTimes((data.meal_times as Record<string, string>) ?? {});
    setMealNotes(data.meal_notes ?? '');
    setSignOff((data.sign_off as Record<string, string>) ?? {});
    setScheduleNotes(data.schedule_notes ?? '');
    setParkingNotes(data.parking_notes ?? '');
    setSecurityNotes(data.security_notes ?? '');
    setOtherNotes(data.other_notes ?? '');

    if (data.visible_to_all) {
      setVisibility('org');
    } else {
      const { count } = await supabase
        .from('resource_shares')
        .select('id', { count: 'exact', head: true })
        .eq('resource_type', 'advance')
        .eq('resource_id', data.id);
      setVisibility(count && count > 0 ? 'specific' : 'department');
    }

    const [contactsRes, laborRes, hospitalityRes, roomsRes] = await Promise.all([
      supabase.from('advance_contacts').select('id, category, name, role, phone, email').eq('advance_id', data.id),
      supabase.from('advance_crew_labor').select('id, role, call_time, count').eq('advance_id', data.id),
      supabase
        .from('advance_hospitality_items')
        .select('id, group_name, item, quantity, notes, fulfilled')
        .eq('advance_id', data.id),
      supabase.from('advance_room_assignments').select('id, room_label, assigned_to, notes').eq('advance_id', data.id),
    ]);
    const contacts = (contactsRes.data ?? []) as (Person & { category: string })[];
    setKeyContacts(contacts.filter((c) => c.category === 'key'));
    setVendors(contacts.filter((c) => c.category === 'vendor'));
    setVenueStaff(contacts.filter((c) => c.category === 'venue_staff'));
    setCrewLabor((laborRes.data ?? []) as LaborRow[]);
    setHospitalityItems((hospitalityRes.data ?? []) as HospitalityRow[]);
    setRoomAssignments((roomsRes.data ?? []) as RoomRow[]);
  }

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load().finally(() => setLoading(false));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tourDateId])
  );

  async function handleSave() {
    if (!session) return;
    setErrorMessage(null);
    setSaving(true);

    const payload = {
      department,
      visible_to_all: visibility === 'org',
      status,
      power,
      stage_specs: stageSpecs,
      production_requirements: productionRequirements,
      equipment_needs: equipmentNeeds,
      headcounts,
      meal_times: mealTimes,
      meal_notes: mealNotes.trim() || null,
      sign_off: signOff,
      schedule_notes: scheduleNotes.trim() || null,
      parking_notes: parkingNotes.trim() || null,
      security_notes: securityNotes.trim() || null,
      other_notes: otherNotes.trim() || null,
      updated_by: session.user.id,
      updated_at: new Date().toISOString(),
    };

    let error;
    if (advanceId) {
      ({ error } = await supabase.from('advances').update(payload).eq('id', advanceId));
    } else {
      const newAdvanceId = newId();
      ({ error } = await supabase.from('advances').insert({
        id: newAdvanceId,
        tour_date_id: tourDateId,
        created_by: session.user.id,
        ...payload,
      }));
      if (!error) setAdvanceId(newAdvanceId);
    }

    setSaving(false);
    if (error) setErrorMessage(error.message);
  }

  async function handlePrint() {
    setPrinting(true);
    try {
      await Print.printAsync({
        html: buildAdvanceSheetHtml({
          headliner,
          venueName,
          city,
          dateLabel: tourDateLabel,
          status: STATUSES.find((s) => s.value === status)?.label ?? status,
          keyContacts,
          vendors,
          venueStaff,
          crewLabor,
          scheduleItems: scheduleItems.map((s) => ({ start_time: s.start_time, title: s.title, location: s.location })),
          power,
          stageSpecs,
          productionRequirements,
          equipmentNeeds,
          headcounts,
          hospitalityItems,
          mealTimes,
          mealNotes: mealNotes.trim() || null,
          roomAssignments,
          signOff,
          scheduleNotes: scheduleNotes.trim() || null,
          parkingNotes: parkingNotes.trim() || null,
          securityNotes: securityNotes.trim() || null,
          otherNotes: otherNotes.trim() || null,
        }),
      });
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to print.');
    }
    setPrinting(false);
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Advance</Text>
      <Text style={styles.subtitle}>{tourDateLabel}</Text>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <Text style={styles.sectionTitle}>Status</Text>
      <View style={styles.chipRow}>
        {STATUSES.map((s) => (
          <Pressable key={s.value} style={[styles.chip, status === s.value && styles.chipActive]} onPress={() => setStatus(s.value)}>
            <Text style={[styles.chipText, status === s.value && styles.chipTextActive]}>{s.label}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.sectionTitle}>Owning department</Text>
      <View style={styles.chipRow}>
        {DEPARTMENTS.map((d) => (
          <Pressable key={d} style={[styles.chip, department === d && styles.chipActive]} onPress={() => setDepartment(d)}>
            <Text style={[styles.chipText, department === d && styles.chipTextActive]}>{formatDepartment(d)}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.sectionTitle}>Who can see it</Text>
      <Pressable
        style={[styles.visibilityRow, visibility === 'department' && styles.visibilityRowSelected]}
        onPress={() => setVisibility('department')}
      >
        <Text style={styles.visibilityText}>Managers + this department</Text>
        {visibility === 'department' && <Text style={styles.check}>✓</Text>}
      </Pressable>
      <Pressable
        style={[styles.visibilityRow, visibility === 'org' && styles.visibilityRowSelected]}
        onPress={() => setVisibility('org')}
      >
        <Text style={styles.visibilityText}>Everyone on the tour</Text>
        {visibility === 'org' && <Text style={styles.check}>✓</Text>}
      </Pressable>
      <Pressable
        style={[styles.visibilityRow, visibility === 'specific' && styles.visibilityRowSelected]}
        onPress={() => setVisibility('specific')}
      >
        <Text style={styles.visibilityText}>Specific people or departments</Text>
        {visibility === 'specific' && <Text style={styles.check}>✓</Text>}
      </Pressable>

      <Pressable style={styles.saveButton} onPress={handleSave} disabled={saving}>
        {saving ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.saveButtonText}>Save Advance</Text>}
      </Pressable>

      {!advanceId && (
        <Text style={styles.visibilityHint}>Save once first, then come back here to add contacts, crew, hospitality, and more.</Text>
      )}

      {advanceId && (
        <>
          <PeopleSection
            title="Key Contacts"
            people={keyContacts}
            table="advance_contacts"
            category="key"
            advanceId={advanceId}
            onChange={setKeyContacts}
            styles={styles}
            colors={colors}
          />
          <PeopleSection
            title="Vendors"
            people={vendors}
            table="advance_contacts"
            category="vendor"
            advanceId={advanceId}
            onChange={setVendors}
            styles={styles}
            colors={colors}
            rolePlaceholder="Audio, Lighting, Catering…"
          />
          <PeopleSection
            title="Venue Staff"
            people={venueStaff}
            table="advance_contacts"
            category="venue_staff"
            advanceId={advanceId}
            onChange={setVenueStaff}
            styles={styles}
            colors={colors}
            rolePlaceholder="Building Event Mgr, Security…"
          />

          <LaborSection crewLabor={crewLabor} advanceId={advanceId} onChange={setCrewLabor} styles={styles} colors={colors} />

          <ScheduleSection
            scheduleItems={scheduleItems}
            tourDateId={tourDateId}
            department={department}
            onChange={setScheduleItems}
            styles={styles}
            colors={colors}
          />

          <SpecGroup
            title="Power"
            fields={[
              { key: 'lights', label: 'Tour Lights' },
              { key: 'sound', label: 'Tour Sound' },
              { key: 'rigging', label: 'Tour Rigging' },
              { key: 'pyro', label: 'Tour Pyro' },
            ]}
            values={power}
            onChange={setPower}
            styles={styles}
            colors={colors}
          />

          <SpecGroup
            title="Stage & Rigging"
            fields={[
              { key: 'requested_stage', label: 'Requested Stage' },
              { key: 'stage_wings', label: 'Stage Wings' },
              { key: 'upstage_black', label: 'Upstage Black' },
              { key: 'stage_stairs', label: 'Stage Stairs' },
              { key: 'stage_risers', label: 'Stage Risers' },
              { key: 'mix_position', label: 'Audio/Lighting Mix' },
              { key: 'total_weight_load', label: 'Total Weight Load' },
              { key: 'rigging_points', label: '# of Points' },
            ]}
            values={stageSpecs}
            onChange={setStageSpecs}
            styles={styles}
            colors={colors}
          />

          <ChecklistGroup
            title="Production Requirements"
            fields={[
              { key: 'tour_audio', label: 'Tour Audio' },
              { key: 'tour_lighting', label: 'Tour Lighting' },
              { key: 'tour_monitors', label: 'Tour Monitors' },
              { key: 'tour_video', label: 'Tour Video' },
              { key: 'tour_fx_lasers', label: 'FX / Lasers / Stage Riser' },
              { key: 'tour_barricade', label: 'Tour Barricade' },
              { key: 'tour_clear_comm', label: 'Tour Clear Comm' },
              { key: 'tour_drape_backdrop', label: 'Tour Drape / Backdrop' },
            ]}
            values={productionRequirements}
            onChange={setProductionRequirements}
            styles={styles}
          />

          <SpecGroup
            title="Equipment Needs"
            fields={[
              { key: 'vehicles', label: 'Vehicles' },
              { key: 'gases', label: 'Gases' },
              { key: 'forklift', label: 'Forklift' },
            ]}
            values={equipmentNeeds}
            onChange={setEquipmentNeeds}
            styles={styles}
            colors={colors}
          />

          <SpecGroup
            title="Numbers"
            fields={[
              { key: 'backstage_working_area', label: 'Backstage / Working Area' },
              { key: 'meet_greet', label: 'Meet & Greet' },
              { key: 'dressing_rooms', label: 'Dressing Rooms' },
              { key: 'trucks_buses', label: 'Trucks & Buses' },
              { key: 'backstage_entrance', label: 'Backstage Entrance' },
              { key: 'medical_emts', label: 'Medical / EMTs' },
            ]}
            values={headcounts}
            onChange={setHeadcounts}
            styles={styles}
            colors={colors}
            keyboardType="number-pad"
          />

          <HospitalitySection items={hospitalityItems} advanceId={advanceId} onChange={setHospitalityItems} styles={styles} colors={colors} />

          <SpecGroup
            title="Meal Times"
            fields={[
              { key: 'breakfast', label: 'Breakfast' },
              { key: 'lunch', label: 'Lunch' },
              { key: 'dinner', label: 'Dinner' },
            ]}
            values={mealTimes}
            onChange={setMealTimes}
            styles={styles}
            colors={colors}
          />
          <Section styles={styles} colors={colors} label="Meal Notes (allergies, vegan/vegetarian)" value={mealNotes} onChange={setMealNotes} />

          <RoomsSection rooms={roomAssignments} advanceId={advanceId} onChange={setRoomAssignments} styles={styles} colors={colors} />

          <Section styles={styles} colors={colors} label="Additional Schedule Notes" value={scheduleNotes} onChange={setScheduleNotes} />
          <Section styles={styles} colors={colors} label="Parking" value={parkingNotes} onChange={setParkingNotes} />
          <Section styles={styles} colors={colors} label="Security" value={securityNotes} onChange={setSecurityNotes} />
          <Section styles={styles} colors={colors} label="Other" value={otherNotes} onChange={setOtherNotes} />

          <SpecGroup
            title="Sign-off"
            fields={[
              { key: 'audit_cap_sold_map', label: 'Audit / Cap / Sold Map' },
              { key: 'haze_policy', label: 'Haze' },
              { key: 'advanced_by', label: 'Advanced By' },
              { key: 'tour_promo_rep', label: 'Tour Promo Rep' },
            ]}
            values={signOff}
            onChange={setSignOff}
            styles={styles}
            colors={colors}
          />

          <Pressable style={styles.saveButton} onPress={handleSave} disabled={saving}>
            {saving ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.saveButtonText}>Save Advance</Text>}
          </Pressable>

          <Pressable style={styles.printButton} onPress={handlePrint} disabled={printing}>
            {printing ? <ActivityIndicator color={colors.accent} /> : <Text style={styles.printButtonText}>Print Advance Sheet</Text>}
          </Pressable>
        </>
      )}
    </ScrollView>
  );
}

function Section({
  label,
  value,
  onChange,
  styles,
  colors,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  styles: Styles;
  colors: ThemeColors;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{label}</Text>
      <TextInput
        style={styles.textArea}
        placeholder={`${label} details…`}
        placeholderTextColor={colors.textFaint}
        value={value}
        onChangeText={onChange}
        multiline
      />
    </View>
  );
}

/** A fixed set of label:value text fields bound to one jsonb column — power, stage specs, equipment, headcounts, meal times, sign-off. */
function SpecGroup({
  title,
  fields,
  values,
  onChange,
  styles,
  colors,
  keyboardType,
}: {
  title: string;
  fields: { key: string; label: string }[];
  values: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  styles: Styles;
  colors: ThemeColors;
  keyboardType?: 'default' | 'number-pad';
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {fields.map((f) => (
        <View key={f.key} style={styles.specRow}>
          <Text style={styles.specLabel}>{f.label}</Text>
          <TextInput
            style={styles.specInput}
            placeholder="—"
            placeholderTextColor={colors.textFaint}
            value={values[f.key] ?? ''}
            onChangeText={(v) => onChange({ ...values, [f.key]: v })}
            keyboardType={keyboardType}
          />
        </View>
      ))}
    </View>
  );
}

/** Same shape as SpecGroup, but each field is a YES / NO / TBD chip instead of free text — the production-requirements checklist. */
function ChecklistGroup({
  title,
  fields,
  values,
  onChange,
  styles,
}: {
  title: string;
  fields: { key: string; label: string }[];
  values: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  styles: Styles;
}) {
  const options = ['Yes', 'No', 'TBD'];
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {fields.map((f) => (
        <View key={f.key} style={styles.checklistRow}>
          <Text style={styles.specLabel}>{f.label}</Text>
          <View style={styles.checklistChips}>
            {options.map((opt) => (
              <Pressable
                key={opt}
                style={[styles.miniChip, values[f.key] === opt && styles.miniChipActive]}
                onPress={() => onChange({ ...values, [f.key]: opt })}
              >
                <Text style={[styles.miniChipText, values[f.key] === opt && styles.miniChipTextActive]}>{opt}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

/** Key Contacts / Vendors / Venue Staff — all the same advance_contacts table, filtered by category. Mirrors ArtistDetailScreen's contact-list pattern. */
function PeopleSection({
  title,
  people,
  table,
  category,
  advanceId,
  onChange,
  styles,
  colors,
  rolePlaceholder = 'Role (Tour Manager, Agent…)',
}: {
  title: string;
  people: Person[];
  table: 'advance_contacts';
  category: string;
  advanceId: string;
  onChange: (p: Person[]) => void;
  styles: Styles;
  colors: ThemeColors;
  rolePlaceholder?: string;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleAdd() {
    if (!name.trim()) return;
    setSaving(true);
    const id = newId();
    const { error } = await supabase.from(table).insert({
      id,
      advance_id: advanceId,
      category,
      name: name.trim(),
      role: role.trim() || null,
      phone: phone.trim() || null,
      email: email.trim() || null,
    });
    setSaving(false);
    if (!error) {
      onChange([...people, { id, name: name.trim(), role: role.trim() || null, phone: phone.trim() || null, email: email.trim() || null }]);
      setName('');
      setRole('');
      setPhone('');
      setEmail('');
      setShowAdd(false);
    }
  }

  function confirmDelete(p: Person) {
    Alert.alert('Remove this contact?', p.name, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from(table).delete().eq('id', p.id);
          if (!error) onChange(people.filter((x) => x.id !== p.id));
        },
      },
    ]);
  }

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <Pressable onPress={() => setShowAdd((v) => !v)}>
          <Text style={styles.sectionAction}>{showAdd ? 'Cancel' : '+ Add'}</Text>
        </Pressable>
      </View>
      {showAdd && (
        <View style={styles.addForm}>
          <TextInput style={styles.input} placeholder="Name" placeholderTextColor={colors.textFaint} value={name} onChangeText={setName} />
          <TextInput style={styles.input} placeholder={rolePlaceholder} placeholderTextColor={colors.textFaint} value={role} onChangeText={setRole} />
          <View style={styles.inputRow}>
            <TextInput style={[styles.input, styles.rowInput]} placeholder="Phone" placeholderTextColor={colors.textFaint} value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
            <TextInput style={[styles.input, styles.rowInput]} placeholder="Email" placeholderTextColor={colors.textFaint} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
          </View>
          <Pressable style={styles.miniSaveButton} onPress={handleAdd} disabled={saving || !name.trim()}>
            {saving ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.miniSaveButtonText}>Save Contact</Text>}
          </Pressable>
        </View>
      )}
      {people.length === 0 && !showAdd && <Text style={styles.emptyText}>None yet.</Text>}
      {people.map((p) => (
        <Pressable key={p.id} style={styles.listRow} onLongPress={() => confirmDelete(p)}>
          <View style={styles.listRowMain}>
            <Text style={styles.listRowTitle}>{p.name}</Text>
            {p.role && <Text style={styles.listRowSubtitle}>{p.role}</Text>}
            {(p.phone || p.email) && <Text style={styles.listRowSubtitle}>{[p.phone, p.email].filter(Boolean).join(' · ')}</Text>}
          </View>
          <Pressable onPress={() => confirmDelete(p)}>
            <Text style={styles.deleteText}>Remove</Text>
          </Pressable>
        </Pressable>
      ))}
    </View>
  );
}

/** Local crew call — role + call time + headcount, with a live total. */
function LaborSection({
  crewLabor,
  advanceId,
  onChange,
  styles,
  colors,
}: {
  crewLabor: LaborRow[];
  advanceId: string;
  onChange: (rows: LaborRow[]) => void;
  styles: Styles;
  colors: ThemeColors;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [role, setRole] = useState('');
  const [callTime, setCallTime] = useState('');
  const [count, setCount] = useState('');
  const [saving, setSaving] = useState(false);

  const total = crewLabor.reduce((sum, c) => sum + (c.count ?? 0), 0);

  async function handleAdd() {
    if (!role.trim()) return;
    setSaving(true);
    const id = newId();
    const parsedCount = count.trim() ? parseInt(count.trim(), 10) : null;
    const { error } = await supabase.from('advance_crew_labor').insert({
      id,
      advance_id: advanceId,
      role: role.trim(),
      call_time: callTime.trim() || null,
      count: parsedCount,
    });
    setSaving(false);
    if (!error) {
      onChange([...crewLabor, { id, role: role.trim(), call_time: callTime.trim() || null, count: parsedCount }]);
      setRole('');
      setCallTime('');
      setCount('');
      setShowAdd(false);
    }
  }

  function confirmDelete(row: LaborRow) {
    Alert.alert('Remove this labor line?', row.role, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('advance_crew_labor').delete().eq('id', row.id);
          if (!error) onChange(crewLabor.filter((x) => x.id !== row.id));
        },
      },
    ]);
  }

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>Local Crew Call</Text>
        <Pressable onPress={() => setShowAdd((v) => !v)}>
          <Text style={styles.sectionAction}>{showAdd ? 'Cancel' : '+ Add'}</Text>
        </Pressable>
      </View>
      {showAdd && (
        <View style={styles.addForm}>
          <TextInput style={styles.input} placeholder="Role (Stagehands, Loaders…)" placeholderTextColor={colors.textFaint} value={role} onChangeText={setRole} />
          <View style={styles.inputRow}>
            <TextInput style={[styles.input, styles.rowInput]} placeholder="Call time (08:00)" placeholderTextColor={colors.textFaint} value={callTime} onChangeText={setCallTime} />
            <TextInput style={[styles.input, styles.rowInput]} placeholder="Count" placeholderTextColor={colors.textFaint} value={count} onChangeText={setCount} keyboardType="number-pad" />
          </View>
          <Pressable style={styles.miniSaveButton} onPress={handleAdd} disabled={saving || !role.trim()}>
            {saving ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.miniSaveButtonText}>Save</Text>}
          </Pressable>
        </View>
      )}
      {crewLabor.length === 0 && !showAdd && <Text style={styles.emptyText}>None yet.</Text>}
      {crewLabor.map((row) => (
        <Pressable key={row.id} style={styles.listRow} onLongPress={() => confirmDelete(row)}>
          <View style={styles.listRowMain}>
            <Text style={styles.listRowTitle}>{row.role}</Text>
            <Text style={styles.listRowSubtitle}>{[row.call_time, row.count != null ? `× ${row.count}` : null].filter(Boolean).join(' — ')}</Text>
          </View>
          <Pressable onPress={() => confirmDelete(row)}>
            <Text style={styles.deleteText}>Remove</Text>
          </Pressable>
        </Pressable>
      ))}
      {crewLabor.length > 0 && (
        <View style={styles.listRow}>
          <Text style={styles.listRowTotal}>Total (labor only)</Text>
          <Text style={styles.listRowTotal}>{total}</Text>
        </View>
      )}
    </View>
  );
}

/** The day's running order — reads/writes the existing schedule_items table directly, scoped to this tour_date. Doesn't require an advanceId. */
function ScheduleSection({
  scheduleItems,
  tourDateId,
  department,
  onChange,
  styles,
  colors,
}: {
  scheduleItems: ScheduleRow[];
  tourDateId: string;
  department: string;
  onChange: (rows: ScheduleRow[]) => void;
  styles: Styles;
  colors: ThemeColors;
}) {
  const { session } = useAuth();
  const [showAdd, setShowAdd] = useState(false);
  const [time, setTime] = useState('');
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleAdd() {
    if (!title.trim() || !session) return;
    setSaving(true);
    const id = newId();
    const { error } = await supabase.from('schedule_items').insert({
      id,
      tour_date_id: tourDateId,
      department,
      title: title.trim(),
      start_time: time.trim() || null,
      location: location.trim() || null,
      created_by: session.user.id,
    });
    setSaving(false);
    if (!error) {
      const next = [...scheduleItems, { id, start_time: time.trim() || null, title: title.trim(), location: location.trim() || null }];
      next.sort((a, b) => (a.start_time ?? '').localeCompare(b.start_time ?? ''));
      onChange(next);
      setTime('');
      setTitle('');
      setLocation('');
      setShowAdd(false);
    }
  }

  function confirmDelete(row: ScheduleRow) {
    Alert.alert('Remove this schedule item?', row.title, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('schedule_items').delete().eq('id', row.id);
          if (!error) onChange(scheduleItems.filter((x) => x.id !== row.id));
        },
      },
    ]);
  }

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>Schedule</Text>
        <Pressable onPress={() => setShowAdd((v) => !v)}>
          <Text style={styles.sectionAction}>{showAdd ? 'Cancel' : '+ Add'}</Text>
        </Pressable>
      </View>
      {showAdd && (
        <View style={styles.addForm}>
          <View style={styles.inputRow}>
            <TextInput style={[styles.input, styles.rowInputSmall]} placeholder="16:00" placeholderTextColor={colors.textFaint} value={time} onChangeText={setTime} />
            <TextInput style={[styles.input, styles.rowInput]} placeholder="Load In, Soundcheck, Doors…" placeholderTextColor={colors.textFaint} value={title} onChangeText={setTitle} />
          </View>
          <TextInput style={styles.input} placeholder="Location (optional)" placeholderTextColor={colors.textFaint} value={location} onChangeText={setLocation} />
          <Pressable style={styles.miniSaveButton} onPress={handleAdd} disabled={saving || !title.trim()}>
            {saving ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.miniSaveButtonText}>Save</Text>}
          </Pressable>
        </View>
      )}
      {scheduleItems.length === 0 && !showAdd && <Text style={styles.emptyText}>None yet.</Text>}
      {scheduleItems.map((row) => (
        <Pressable key={row.id} style={styles.listRow} onLongPress={() => confirmDelete(row)}>
          <View style={styles.listRowMain}>
            <Text style={styles.listRowTitle}>
              <Text style={styles.mono}>{row.start_time?.slice(0, 5) ?? '--:--'}</Text>  {row.title}
            </Text>
            {row.location && <Text style={styles.listRowSubtitle}>{row.location}</Text>}
          </View>
          <Pressable onPress={() => confirmDelete(row)}>
            <Text style={styles.deleteText}>Remove</Text>
          </Pressable>
        </Pressable>
      ))}
    </View>
  );
}

/** Itemized rider needs, grouped by who they're for. */
function HospitalitySection({
  items,
  advanceId,
  onChange,
  styles,
  colors,
}: {
  items: HospitalityRow[];
  advanceId: string;
  onChange: (rows: HospitalityRow[]) => void;
  styles: Styles;
  colors: ThemeColors;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [group, setGroup] = useState(HOSPITALITY_GROUPS[0]);
  const [item, setItem] = useState('');
  const [quantity, setQuantity] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleAdd() {
    if (!item.trim()) return;
    setSaving(true);
    const id = newId();
    const { error } = await supabase.from('advance_hospitality_items').insert({
      id,
      advance_id: advanceId,
      group_name: group,
      item: item.trim(),
      quantity: quantity.trim() || null,
      notes: notes.trim() || null,
      fulfilled: false,
    });
    setSaving(false);
    if (!error) {
      onChange([...items, { id, group_name: group, item: item.trim(), quantity: quantity.trim() || null, notes: notes.trim() || null, fulfilled: false }]);
      setItem('');
      setQuantity('');
      setNotes('');
      setShowAdd(false);
    }
  }

  async function toggleFulfilled(row: HospitalityRow) {
    const { error } = await supabase.from('advance_hospitality_items').update({ fulfilled: !row.fulfilled }).eq('id', row.id);
    if (!error) onChange(items.map((x) => (x.id === row.id ? { ...x, fulfilled: !x.fulfilled } : x)));
  }

  function confirmDelete(row: HospitalityRow) {
    Alert.alert('Remove this item?', row.item, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('advance_hospitality_items').delete().eq('id', row.id);
          if (!error) onChange(items.filter((x) => x.id !== row.id));
        },
      },
    ]);
  }

  const groups = HOSPITALITY_GROUPS.filter((g) => items.some((i) => i.group_name === g)).concat(
    Array.from(new Set(items.map((i) => i.group_name))).filter((g) => !HOSPITALITY_GROUPS.includes(g))
  );

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>Hospitality</Text>
        <Pressable onPress={() => setShowAdd((v) => !v)}>
          <Text style={styles.sectionAction}>{showAdd ? 'Cancel' : '+ Add'}</Text>
        </Pressable>
      </View>
      {showAdd && (
        <View style={styles.addForm}>
          <View style={styles.chipRow}>
            {HOSPITALITY_GROUPS.map((g) => (
              <Pressable key={g} style={[styles.miniChip, group === g && styles.miniChipActive]} onPress={() => setGroup(g)}>
                <Text style={[styles.miniChipText, group === g && styles.miniChipTextActive]}>{g}</Text>
              </Pressable>
            ))}
          </View>
          <TextInput style={styles.input} placeholder="Item" placeholderTextColor={colors.textFaint} value={item} onChangeText={setItem} />
          <View style={styles.inputRow}>
            <TextInput style={[styles.input, styles.rowInput]} placeholder="Quantity" placeholderTextColor={colors.textFaint} value={quantity} onChangeText={setQuantity} />
            <TextInput style={[styles.input, styles.rowInput]} placeholder="Notes" placeholderTextColor={colors.textFaint} value={notes} onChangeText={setNotes} />
          </View>
          <Pressable style={styles.miniSaveButton} onPress={handleAdd} disabled={saving || !item.trim()}>
            {saving ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.miniSaveButtonText}>Save</Text>}
          </Pressable>
        </View>
      )}
      {items.length === 0 && !showAdd && <Text style={styles.emptyText}>None yet.</Text>}
      {groups.map((g) => (
        <View key={g}>
          <Text style={styles.groupLabel}>{g}</Text>
          {items
            .filter((i) => i.group_name === g)
            .map((row) => (
              <Pressable key={row.id} style={styles.listRow} onPress={() => toggleFulfilled(row)} onLongPress={() => confirmDelete(row)}>
                <View style={styles.listRowMain}>
                  <Text style={styles.listRowTitle}>
                    {row.fulfilled ? '✓ ' : ''}
                    {row.item}
                  </Text>
                  {(row.quantity || row.notes) && (
                    <Text style={styles.listRowSubtitle}>{[row.quantity, row.notes].filter(Boolean).join(' — ')}</Text>
                  )}
                </View>
                <Pressable onPress={() => confirmDelete(row)}>
                  <Text style={styles.deleteText}>Remove</Text>
                </Pressable>
              </Pressable>
            ))}
        </View>
      ))}
    </View>
  );
}

/** Which room/office belongs to whom. */
function RoomsSection({
  rooms,
  advanceId,
  onChange,
  styles,
  colors,
}: {
  rooms: RoomRow[];
  advanceId: string;
  onChange: (rows: RoomRow[]) => void;
  styles: Styles;
  colors: ThemeColors;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [roomLabel, setRoomLabel] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleAdd() {
    if (!roomLabel.trim()) return;
    setSaving(true);
    const id = newId();
    const { error } = await supabase.from('advance_room_assignments').insert({
      id,
      advance_id: advanceId,
      room_label: roomLabel.trim(),
      assigned_to: assignedTo.trim() || null,
      notes: notes.trim() || null,
    });
    setSaving(false);
    if (!error) {
      onChange([...rooms, { id, room_label: roomLabel.trim(), assigned_to: assignedTo.trim() || null, notes: notes.trim() || null }]);
      setRoomLabel('');
      setAssignedTo('');
      setNotes('');
      setShowAdd(false);
    }
  }

  function confirmDelete(row: RoomRow) {
    Alert.alert('Remove this assignment?', row.room_label, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.from('advance_room_assignments').delete().eq('id', row.id);
          if (!error) onChange(rooms.filter((x) => x.id !== row.id));
        },
      },
    ]);
  }

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>Room Assignments</Text>
        <Pressable onPress={() => setShowAdd((v) => !v)}>
          <Text style={styles.sectionAction}>{showAdd ? 'Cancel' : '+ Add'}</Text>
        </Pressable>
      </View>
      {showAdd && (
        <View style={styles.addForm}>
          <TextInput style={styles.input} placeholder="Room (Crew Room, DR 1…)" placeholderTextColor={colors.textFaint} value={roomLabel} onChangeText={setRoomLabel} />
          <TextInput style={styles.input} placeholder="Assigned to" placeholderTextColor={colors.textFaint} value={assignedTo} onChangeText={setAssignedTo} />
          <TextInput style={styles.input} placeholder="Notes" placeholderTextColor={colors.textFaint} value={notes} onChangeText={setNotes} />
          <Pressable style={styles.miniSaveButton} onPress={handleAdd} disabled={saving || !roomLabel.trim()}>
            {saving ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.miniSaveButtonText}>Save</Text>}
          </Pressable>
        </View>
      )}
      {rooms.length === 0 && !showAdd && <Text style={styles.emptyText}>None yet.</Text>}
      {rooms.map((row) => (
        <Pressable key={row.id} style={styles.listRow} onLongPress={() => confirmDelete(row)}>
          <View style={styles.listRowMain}>
            <Text style={styles.listRowTitle}>{row.room_label}</Text>
            {(row.assigned_to || row.notes) && (
              <Text style={styles.listRowSubtitle}>{[row.assigned_to, row.notes].filter(Boolean).join(' — ')}</Text>
            )}
          </View>
          <Pressable onPress={() => confirmDelete(row)}>
            <Text style={styles.deleteText}>Remove</Text>
          </Pressable>
        </Pressable>
      ))}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    centered: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
    content: { padding: 20, paddingBottom: 60 },
    title: { color: colors.text, fontSize: 22, fontFamily: fonts.displayBold },
    subtitle: { color: colors.textDim, fontSize: 13, marginTop: 4, marginBottom: 16, fontFamily: fonts.body },
    error: { color: colors.danger, fontSize: 13, marginBottom: 12, fontFamily: fonts.body },
    sectionTitle: { color: colors.textDim, fontSize: 12, fontFamily: fonts.bodySemiBold, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 14, marginBottom: 8 },
    sectionHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 },
    sectionAction: { color: colors.accent, fontSize: 13, fontFamily: fonts.bodySemiBold },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: { backgroundColor: colors.surface2, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 },
    chipActive: { backgroundColor: colors.accent },
    chipText: { color: colors.textDim, fontSize: 13, fontFamily: fonts.bodySemiBold },
    chipTextActive: { color: colors.onAccent },
    visibilityRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      backgroundColor: colors.surface,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 10,
      marginBottom: 6,
      borderWidth: 1,
      borderColor: colors.border,
    },
    visibilityRowSelected: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
    visibilityText: { color: colors.text, fontSize: 14, fontFamily: fonts.body },
    check: { color: colors.accent, fontSize: 14, fontFamily: fonts.bodyBold },
    visibilityHint: { color: colors.textFaint, fontSize: 12, marginTop: 8, fontStyle: 'italic', fontFamily: fonts.body },
    section: { marginTop: 4 },
    textArea: {
      backgroundColor: colors.surface,
      color: colors.text,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 14,
      fontFamily: fonts.body,
      minHeight: 70,
      textAlignVertical: 'top',
      borderWidth: 1,
      borderColor: colors.border,
    },
    saveButton: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 20 },
    saveButtonText: { color: colors.onAccent, fontSize: 16, fontFamily: fonts.bodySemiBold },
    printButton: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 10, marginBottom: 20 },
    printButtonText: { color: colors.accent, fontSize: 15, fontFamily: fonts.bodySemiBold },
    addForm: { backgroundColor: colors.surface, borderRadius: 10, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.border, gap: 8 },
    input: {
      backgroundColor: colors.surface2,
      color: colors.text,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 9,
      fontSize: 13,
      fontFamily: fonts.body,
    },
    inputRow: { flexDirection: 'row', gap: 8 },
    rowInput: { flex: 1 },
    rowInputSmall: { width: 80 },
    miniSaveButton: { backgroundColor: colors.accent, borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
    miniSaveButtonText: { color: colors.onAccent, fontSize: 13, fontFamily: fonts.bodySemiBold },
    emptyText: { color: colors.textFaint, fontSize: 13, fontStyle: 'italic', fontFamily: fonts.body, marginBottom: 4 },
    listRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      marginBottom: 4,
      borderWidth: 1,
      borderColor: colors.border,
    },
    listRowMain: { flex: 1, gap: 2 },
    listRowTitle: { color: colors.text, fontSize: 14, fontFamily: fonts.bodySemiBold },
    listRowSubtitle: { color: colors.textDim, fontSize: 12, fontFamily: fonts.body },
    listRowTotal: { color: colors.text, fontSize: 13, fontFamily: fonts.bodyBold },
    mono: { fontFamily: fonts.mono, color: colors.accent },
    deleteText: { color: colors.danger, fontSize: 12, fontFamily: fonts.bodySemiBold },
    groupLabel: { color: colors.text, fontSize: 12, fontFamily: fonts.bodySemiBold, marginTop: 8, marginBottom: 4 },
    specRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 5, gap: 12 },
    specLabel: { color: colors.text, fontSize: 13, fontFamily: fonts.body, flex: 1 },
    specInput: {
      backgroundColor: colors.surface,
      color: colors.text,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 7,
      fontSize: 13,
      fontFamily: fonts.mono,
      borderWidth: 1,
      borderColor: colors.border,
      flex: 1,
      textAlign: 'right',
    },
    checklistRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 5, gap: 8 },
    checklistChips: { flexDirection: 'row', gap: 6 },
    miniChip: { backgroundColor: colors.surface2, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5 },
    miniChipActive: { backgroundColor: colors.accent },
    miniChipText: { color: colors.textDim, fontSize: 11, fontFamily: fonts.bodySemiBold },
    miniChipTextActive: { color: colors.onAccent },
  });
}
