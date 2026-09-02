/**
 * ViewDocumentScreen — in-app file viewer, generic over `bucket` +
 * `storagePath` rather than document-specific, so it covers both
 * DocumentsScreen's `tour-documents` bucket and BudgetScreen's
 * `tour-receipts` bucket with one screen. Fetches its own signed URL
 * fresh on mount (not reused from wherever the caller generated one) —
 * signed URLs are short-lived and there's no guarantee this screen opens
 * immediately after navigation.
 *
 * Rendering fidelity is genuinely platform-dependent, not something to
 * pretend is solved everywhere: PDFs and images render inline reliably
 * via WebView on iOS and web, but Android's native WebView is
 * historically unreliable at rendering PDFs inline (it often triggers a
 * download instead of showing the file). "Open externally" stays
 * available as a real fallback, not just an error-state escape hatch,
 * since a broken Android render can show up as a blank view rather than
 * a caught error.
 *
 * Theme (Manrope/JetBrains Mono, navy accent) per the "Load-In" design
 * review — see lib/theme.tsx.
 */
import { useCallback, useMemo, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { supabase } from '../lib/supabase';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'ViewDocument'>;

export function ViewDocumentScreen({ route }: Props) {
  const { bucket, storagePath, title } = route.params;
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function load() {
    setErrorMessage(null);
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(storagePath, 60 * 5);
    if (error || !data) {
      setErrorMessage(error?.message ?? 'Failed to open this file.');
      return;
    }
    setSignedUrl(data.signedUrl);
  }

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load().finally(() => setLoading(false));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bucket, storagePath])
  );

  function openExternally() {
    if (signedUrl) Linking.openURL(signedUrl);
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
        <Pressable onPress={openExternally} disabled={!signedUrl}>
          <Text style={styles.externalLink}>Open externally</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : errorMessage ? (
        <View style={styles.centered}>
          <Text style={styles.error}>{errorMessage}</Text>
        </View>
      ) : signedUrl ? (
        <WebView source={{ uri: signedUrl }} style={styles.webview} startInLoadingState renderLoading={() => (
          <View style={styles.centered}>
            <ActivityIndicator color={colors.accent} />
          </View>
        )} />
      ) : null}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    title: { color: colors.text, fontSize: 15, fontFamily: fonts.displaySemiBold, flex: 1, marginRight: 12 },
    externalLink: { color: colors.accent, fontSize: 13, fontFamily: fonts.bodySemiBold },
    error: { color: colors.danger, fontSize: 14, textAlign: 'center', paddingHorizontal: 24, fontFamily: fonts.body },
    webview: { flex: 1, backgroundColor: colors.bg },
  });
}
