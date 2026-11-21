/**
 * StampBadge — a small rotated, outlined status tag that reads like a
 * rubber ink stamp on a backstage pass, not a plain colored dot+label.
 * Pass a `tone` rather than a raw color so the same three meanings stay
 * consistent everywhere this is used: 'signature' (amber — active/
 * upcoming/confirmed), 'spark' (ticket-red — needs attention/pending),
 * 'neutral' (faint ink — completed/inactive/past).
 */
import { Text, StyleSheet } from 'react-native';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';

type Tone = 'signature' | 'spark' | 'neutral';

export function StampBadge({ label, tone = 'signature' }: { label: string; tone?: Tone }) {
  const { colors } = useTheme();
  const styles = createStyles(colors);
  const color = tone === 'signature' ? colors.accent : tone === 'spark' ? colors.spark : colors.textFaint;

  return <Text style={[styles.stamp, { color, borderColor: color }]}>{label}</Text>;
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    stamp: {
      fontFamily: fonts.bodyBold,
      fontSize: 12,
      letterSpacing: 0.5,
      textTransform: 'uppercase',
      paddingHorizontal: 9,
      paddingVertical: 3,
      borderWidth: 1.5,
      borderRadius: 5,
      transform: [{ rotate: '-4deg' }],
      alignSelf: 'flex-start',
    },
  });
}
