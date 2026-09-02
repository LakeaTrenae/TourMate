/**
 * AddChecklistScreen — create a new checklist (venue walkthrough,
 * hospitality & rider notes, load-in, whatever). Items get added
 * afterward on ChecklistDetailScreen, not here — keeping creation to
 * "title + who owns it + who can see it" keeps this form short.
 *
 * Theme (Manrope/JetBrains Mono, navy accent) per the "Load-In" design
 * review — see lib/theme.tsx.
 */
import { useEffect, useMemo, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { newId } from '../lib/ids';
import { fetchTourRoster, type RosterMember } from '../lib/roster';
import { formatDepartment } from '../lib/format';
import { logAuditEvent } from '../lib/auditLog';
import { notify } from '../lib/notify';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'AddChecklist'>;

const DEPARTMENTS = ['general', 'production', 'security', 'travel', 'artist_relations', 'finance', 'tour_management'];
// Same "specific people or departments" checkbox model as AddDocumentScreen —
// the base visible_to_all column only stores true/false, so 'specific' is
// visible_to_all=false plus resource_shares rows layered on top, not a
// third stored value.
type Visibility = 'department' | 'org' | 'specific';

// A couple of common starting points so nobody has to type "stage power"
// and "parking" from scratch every tour — picking one pre-fills items,
// but the title/department/visibility are still theirs to set.
const TEMPLATES: { label: string; title: string; department: string; items: string[] }[] = [
  {
    label: 'Venue Walkthrough',
    title: 'Venue Walkthrough',
    department: 'production',
    items: [
      'Stage dimensions & load-in path',
      'Power (amps, distro location)',
      'Loading dock / parking access',
      'Dressing rooms & green room',
      'Front-of-house & mix position',
      'Wifi / network access',
      'Security office & emergency exits',
      'Medical station location',
      'Restrooms (crew + guest)',
      'Catering / hospitality space',
      'Merch location',
      'Local noise curfew / restrictions',
    ],
  },
  {
    label: 'Hospitality & Rider',
    title: 'Hospitality & Rider Notes',
    department: 'production',
    items: [
      'Technical rider sent to venue',
      'Hospitality rider sent to venue',
      'Catering confirmed (headcount + time)',
      'Green room requests confirmed',
      'Local crew / runners confirmed',
      'Towels & water at FOH and stage',
      'Dietary restrictions communicated',
    ],
  },
];

export function AddChecklistScreen({ route, navigation }: Props) {
  const { tourId } = route.params;
  const { session } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [title, setTitle] = useState('');
  const [department, setDepartment] = useState('production');
  const [visibility, setVisibility] = useState<Visibility>('org');
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [selectedDepartments, setSelectedDepartments] = useState<Set<string>>(new Set());
  const [items, setItems] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    fetchTourRoster(tourId)
      .then(setRoster)
      .catch(() => {});
  }, [tourId]);

  function toggleUser(userId: string) {
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  function toggleDepartmentShare(dept: string) {
    setSelectedDepartments((prev) => {
      const next = new Set(prev);
      if (next.has(dept)) next.delete(dept);
      else next.add(dept);
      return next;
    });
  }

  function applyTemplate(template: (typeof TEMPLATES)[number]) {
    setTitle(template.title);
    setDepartment(template.department);
    setItems(template.items);
  }

  async function handleSubmit() {
    setErrorMessage(null);
    if (!title.trim()) {
      setErrorMessage('Give this checklist a title.');
      return;
    }
    if (!session) return;
    if (visibility === 'specific' && selectedUserIds.size === 0 && selectedDepartments.size === 0) {
      setErrorMessage('Pick at least one person or department, or choose a different visibility option.');
      return;
    }

    setSubmitting(true);

    const checklistId = newId();
    const { error: checklistError } = await supabase.from('checklists').insert({
      id: checklistId,
      tour_id: tourId,
      title: title.trim(),
      department,
      visible_to_all: visibility === 'org',
    });
    if (checklistError) {
      setSubmitting(false);
      setErrorMessage(checklistError.message);
      return;
    }

    if (visibility === 'specific') {
      const shareRows = [
        ...Array.from(selectedUserIds).map((userId) => ({
          tour_id: tourId,
          resource_type: 'checklist',
          resource_id: checklistId,
          shared_with_user_id: userId,
          shared_with_department: null,
          permission: 'view' as const,
          granted_by: session.user.id,
        })),
        ...Array.from(selectedDepartments).map((dept) => ({
          tour_id: tourId,
          resource_type: 'checklist',
          resource_id: checklistId,
          shared_with_user_id: null,
          shared_with_department: dept,
          permission: 'view' as const,
          granted_by: session.user.id,
        })),
      ];
      const { error: shareError } = await supabase.from('resource_shares').insert(shareRows);
      if (shareError) {
        setSubmitting(false);
        setErrorMessage(`Checklist created, but sharing failed: ${shareError.message}`);
        return;
      }
      logAuditEvent({
        tourId,
        actorId: session.user.id,
        action: 'share',
        resourceType: 'resource_share',
        resourceId: checklistId,
        detail: { resource_type: 'checklist', user_count: selectedUserIds.size, department_count: selectedDepartments.size },
      });
      const departmentTargets = roster.filter((r) => selectedDepartments.has(r.department)).map((r) => r.user_id);
      const allTargets = Array.from(new Set([...selectedUserIds, ...departmentTargets]));
      notify({
        tourId,
        targetUserIds: allTargets,
        title: 'Checklist shared with you',
        body: title.trim(),
        data: { type: 'checklist_share', checklistId },
      });
    }

    if (items.length > 0) {
      const { error: itemsError } = await supabase.from('checklist_items').insert(
        items.map((description, index) => ({
          id: newId(),
          checklist_id: checklistId,
          description,
          position: index,
        }))
      );
      if (itemsError) {
        setSubmitting(false);
        setErrorMessage(`Checklist created, but starting items failed: ${itemsError.message}`);
        return;
      }
    }

    setSubmitting(false);
    navigation.goBack();
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>New Checklist</Text>

      <Text style={styles.sectionTitle}>Start from a template (optional)</Text>
      <View style={styles.templateRow}>
        {TEMPLATES.map((t) => (
          <Pressable key={t.label} style={styles.templateChip} onPress={() => applyTemplate(t)}>
            <Text style={styles.templateChipText}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      <TextInput
        style={styles.input}
        placeholder="Checklist title"
        placeholderTextColor={colors.textFaint}
        value={title}
        onChangeText={setTitle}
      />

      <Text style={styles.sectionTitle}>Department (owns editing)</Text>
      <View style={styles.chipRow}>
        {DEPARTMENTS.map((d) => (
          <Pressable
            key={d}
            style={[styles.chip, department === d && styles.chipActive]}
            onPress={() => setDepartment(d)}
          >
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

      {visibility === 'specific' && (
        <View style={styles.shareBox}>
          <Text style={styles.shareBoxLabel}>Departments</Text>
          {DEPARTMENTS.map((d) => {
            const checked = selectedDepartments.has(d);
            return (
              <Pressable key={d} style={styles.checkboxRow} onPress={() => toggleDepartmentShare(d)}>
                <View style={[styles.checkbox, checked && styles.checkboxChecked]}>{checked && <Text style={styles.checkmark}>✓</Text>}</View>
                <Text style={styles.checkboxLabel}>{formatDepartment(d)}</Text>
              </Pressable>
            );
          })}

          {roster.length > 0 && (
            <>
              <Text style={[styles.shareBoxLabel, styles.shareBoxLabelSpaced]}>People</Text>
              {roster.map((member) => {
                const checked = selectedUserIds.has(member.user_id);
                return (
                  <Pressable key={member.user_id} style={styles.checkboxRow} onPress={() => toggleUser(member.user_id)}>
                    <View style={[styles.checkbox, checked && styles.checkboxChecked]}>{checked && <Text style={styles.checkmark}>✓</Text>}</View>
                    <Text style={styles.checkboxLabel}>{member.display_name}</Text>
                  </Pressable>
                );
              })}
            </>
          )}
        </View>
      )}

      {items.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>Starting items ({items.length})</Text>
          <Text style={styles.templateHint}>You can add, edit, or remove items after creating the checklist.</Text>
        </>
      )}

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}

      <Pressable style={styles.submitButton} onPress={handleSubmit} disabled={submitting}>
        {submitting ? <ActivityIndicator color={colors.onAccent} /> : <Text style={styles.submitButtonText}>Create Checklist</Text>}
      </Pressable>
    </ScrollView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    content: { padding: 20, paddingBottom: 60 },
    title: { color: colors.text, fontSize: 22, fontFamily: fonts.displayBold, marginBottom: 16 },
    sectionTitle: { color: colors.textDim, fontSize: 12, fontFamily: fonts.bodySemiBold, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 14, marginBottom: 8 },
    templateHint: { color: colors.textFaint, fontSize: 12, marginTop: -4, marginBottom: 4, fontFamily: fonts.body },
    templateRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    templateChip: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    templateChipText: { color: colors.accent, fontSize: 13, fontFamily: fonts.bodySemiBold },
    input: {
      backgroundColor: colors.surface,
      color: colors.text,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      marginTop: 4,
      fontSize: 15,
      fontFamily: fonts.body,
      borderWidth: 1,
      borderColor: colors.border,
    },
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
    shareBox: { backgroundColor: colors.surface2, borderRadius: 10, padding: 14, marginBottom: 6 },
    shareBoxLabel: { color: colors.textDim, fontSize: 11, fontFamily: fonts.bodySemiBold, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
    shareBoxLabelSpaced: { marginTop: 14 },
    checkboxRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
    checkbox: {
      width: 20,
      height: 20,
      borderRadius: 5,
      borderWidth: 2,
      borderColor: colors.textFaint,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 10,
    },
    checkboxChecked: { backgroundColor: colors.accent, borderColor: colors.accent },
    checkmark: { color: colors.onAccent, fontSize: 12, fontFamily: fonts.bodyBold },
    checkboxLabel: { color: colors.text, fontSize: 14, fontFamily: fonts.body },
    error: { color: colors.danger, fontSize: 13, marginTop: 12, fontFamily: fonts.body },
    submitButton: { backgroundColor: colors.accent, borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 20 },
    submitButtonText: { color: colors.onAccent, fontSize: 16, fontFamily: fonts.bodySemiBold },
  });
}
