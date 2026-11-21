/**
 * MarqueeChaseLight — three dots pulsing in sequence, like the chase
 * lights ringing a real theater marquee. Pure decoration (entrance
 * moments: Auth screen, splash-ish headers), never a loading indicator —
 * use ActivityIndicator for that.
 */
import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { useTheme, type ThemeColors } from '../lib/theme';

export function MarqueeChaseLight() {
  const { colors } = useTheme();
  const styles = createStyles(colors);
  const anims = useRef([0, 1, 2].map(() => new Animated.Value(0.25))).current;

  useEffect(() => {
    const loops = anims.map((val, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 180),
          Animated.timing(val, { toValue: 1, duration: 360, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(val, { toValue: 0.25, duration: 360, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.delay((2 - i) * 180),
        ])
      )
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [anims]);

  return (
    <View style={styles.row}>
      {anims.map((val, i) => (
        <Animated.View key={i} style={[styles.dot, { opacity: val }]} />
      ))}
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    row: { flexDirection: 'row', gap: 6, justifyContent: 'center' },
    dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.accent },
  });
}
