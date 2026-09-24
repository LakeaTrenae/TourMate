/**
 * ImportScreen — "What are you importing?" A single generalized entry
 * point that routes to whichever specific AI-import flow applies
 * (Schedule / Budget / Guest List), each already its own proven
 * review-before-commit screen. Photos and documents already have a fully
 * generalized upload flow elsewhere (AddDocumentScreen) and need no entry
 * here; travel has its own TripIt-specific import, reachable from the
 * Travel screen directly since it's a distinct source (a personal feed
 * URL, not a picked file).
 *
 * This doesn't replace the contextual shortcuts already on the Schedule
 * section of the dashboard, BudgetScreen, or TravelScreen — those stay
 * as the fast path from where you'd naturally already be. This is the
 * one-stop version for "I have a pile of documents, where do I start."
 *
 * Theme (Manrope/JetBrains Mono, navy accent) per the "Load-In" design
 * review — see lib/theme.tsx.
 */
import { useMemo } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Import'>;

export function ImportScreen({ route, navigation }: Props) {
  const { tourId, tourName } = route.params;
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Import Data</Text>
      <Text style={styles.subtitle}>{tourName}</Text>
      <Text style={styles.description}>
        Upload a document and we'll pull structured data out of it for you to review before anything's saved.
      </Text>

      <ImportOption
        styles={styles}
        title="Schedule"
        description="A routing sheet, itinerary, or schedule — spreadsheet, PDF, or photo."
        onPress={() => navigation.navigate('ImportSchedule', { tourId })}
      />
      <ImportOption
        styles={styles}
        title="Budget"
        description="A production budget — spreadsheet, PDF, or photo."
        onPress={() => navigation.navigate('ImportBudget', { tourId })}
      />
      <ImportOption
        styles={styles}
        title="Guest List"
        description="A guest list — spreadsheet, PDF, or photo."
        onPress={() => navigation.navigate('ImportGuestList', { tourId })}
      />
    </ScrollView>
  );
}

function ImportOption({
  title,
  description,
  onPress,
  styles,
}: {
  title: string;
  description: string;
  onPress: () => void;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <Pressable style={styles.card} onPress={onPress}>
      <View style={styles.cardMain}>
        <Text style={styles.cardTitle}>{title}</Text>
        <Text style={styles.cardDescription}>{description}</Text>
      </View>
      <Text style={styles.cardArrow}>›</Text>
    </Pressable>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    content: { padding: 20, paddingBottom: 60 },
    title: { color: colors.text, fontSize: 22, fontFamily: fonts.displayBold },
    subtitle: { color: colors.textDim, fontSize: 13, marginTop: 4, fontFamily: fonts.body },
    description: { color: colors.textDim, fontSize: 14, lineHeight: 20, marginTop: 12, marginBottom: 20, fontFamily: fonts.body },
    card: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: 14,
      padding: 16,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: colors.border,
    },
    cardMain: { flex: 1, paddingRight: 12 },
    cardTitle: { color: colors.text, fontSize: 16, fontFamily: fonts.displaySemiBold, marginBottom: 4 },
    cardDescription: { color: colors.textDim, fontSize: 13, lineHeight: 18, fontFamily: fonts.body },
    cardArrow: { color: colors.accent, fontSize: 22, fontFamily: fonts.body },
  });
}
