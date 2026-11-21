/**
 * TicketCard — the "Marquee" design system's signature card shape: a
 * body section, a dashed perforation line with punched-hole notches at
 * each edge, and a stub row below (typically an eyebrow label on the
 * left, a StampBadge on the right) — built to look like a torn ticket
 * stub, since a tour date already genuinely is one.
 *
 * The notches are plain Views colored to the screen's own background
 * (`colors.bg`, not `colors.surface`) and positioned to straddle the
 * card's edge — that's what reads as "punched through," not a sticker
 * stuck on top. The math: body/stub padding is 14, the perforation line
 * is inset the same 14 from the card edge, and a 16-wide notch centered
 * exactly on the card's physical edge sits at `-22` from the
 * perforation's own edge (14 inset + 8 half-width) — straddling it
 * half in, half out, the same way a real ticket's notch does.
 *
 * Omit `stubLeft`/`stubRight` entirely for a plain card with no stub —
 * the perforation line only renders when there's a stub to show.
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme, type ThemeColors } from '../lib/theme';

type Props = {
  children: ReactNode;
  stubLeft?: ReactNode;
  stubRight?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  style?: StyleProp<ViewStyle>;
};

export function TicketCard({ children, stubLeft, stubRight, onPress, onLongPress, style }: Props) {
  const { colors } = useTheme();
  const styles = createStyles(colors);
  const hasStub = !!(stubLeft || stubRight);

  const Wrapper = onPress || onLongPress ? Pressable : View;

  return (
    <Wrapper style={[styles.ticket, style]} onPress={onPress} onLongPress={onLongPress}>
      <View style={styles.body}>{children}</View>
      {hasStub && (
        <>
          <View style={styles.perf}>
            <View style={[styles.notch, styles.notchLeft]} />
            <View style={[styles.notch, styles.notchRight]} />
          </View>
          <View style={styles.stub}>
            <View>{stubLeft}</View>
            <View>{stubRight}</View>
          </View>
        </>
      )}
    </Wrapper>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    ticket: {
      backgroundColor: colors.surface,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.border,
      overflow: 'visible',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.08,
      shadowRadius: 10,
      elevation: 2,
    },
    body: { padding: 14 },
    perf: {
      height: 0,
      borderTopWidth: 2,
      borderTopColor: colors.border,
      borderStyle: 'dashed',
      marginHorizontal: 14,
      position: 'relative',
    },
    notch: {
      position: 'absolute',
      top: -8,
      width: 16,
      height: 16,
      borderRadius: 8,
      backgroundColor: colors.bg,
      borderWidth: 1,
      borderColor: colors.border,
    },
    notchLeft: { left: -22 },
    notchRight: { right: -22 },
    stub: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
  });
}
