/**
 * theme.tsx — the "Marquee" design system (Big Shoulders Display /
 * Manrope / JetBrains Mono, warm-paper neutrals, amber + spark accents),
 * grounded in the touring world itself: stage-lighting gels, laminate
 * color-coding, and routing-sheet paper instead of a cold white/navy
 * SaaS look. Replaces the earlier navy "Load-In" system approved
 * earlier in this project — same centralized-token approach, just new
 * values, confirmed with the user via a design-concept artifact first.
 *
 * One ThemeProvider wraps the app (App.tsx) and every converted screen
 * reads colors/fonts from useTheme() instead of hardcoding hex values —
 * a future palette or type change becomes a one-file edit, not a
 * grep-and-replace across a dozen StyleSheets. This is exactly why the
 * navy -> amber swap below needed zero changes to the 46 already-converted
 * screens themselves.
 *
 * Screens not yet converted to this system keep their existing hardcoded
 * dark styling untouched — this is additive infrastructure, not a
 * forced app-wide reskin.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ThemeMode = 'light' | 'dark';

const STORAGE_KEY = 'themePreference';

// Weight names come straight from @expo-google-fonts' export names — see
// the useFonts() call in App.tsx for where these are actually loaded.
//
// Display now carries real character (Big Shoulders Display — tall,
// condensed, stenciled tour-signage energy) while body/data stay put:
// Manrope and JetBrains Mono were already proven and aren't what the
// "where's the personality" feedback was about. Every screen reads these
// semantic names, never a literal font string, so this swap — like the
// earlier Fraunces -> Manrope one — is this one file, not forty-six.
export const fonts = {
  displayBlack: 'BigShouldersDisplay_900Black', // page-level titles
  displayBold: 'BigShouldersDisplay_700Bold', // section/emphasis headers
  displaySemiBold: 'BigShouldersDisplay_600SemiBold', // card titles
  displayItalic: 'BigShouldersDisplay_600SemiBold', // no italic cut in this family — falls back to upright
  body: 'Manrope_400Regular',
  bodyMedium: 'Manrope_500Medium',
  bodySemiBold: 'Manrope_600SemiBold',
  bodyBold: 'Manrope_700Bold',
  mono: 'JetBrainsMono_400Regular',
  monoMedium: 'JetBrainsMono_500Medium',
};

// "Marquee" palette — grounded in stage-lighting/touring vocabulary, not
// generic SaaS blue. Two decorative colors only: `accent` (amber, the
// "house light" — primary actions/brand) and `spark` (ticket-stub red —
// small playful moments: a hot link, a stamped status, a pending badge).
// `success`/`danger` stay reserved for literal money (income/expense) —
// never spent decoratively — per the explicit "not too many colors"
// direction. `accent2` is kept (duplicating `spark`'s value) solely for
// the one pre-existing VenuesScreen usage; reach for `spark`/`sparkSoft`
// directly in anything new.
const lightColors = {
  bg: '#fbf6ee', // routing-sheet paper, not pure white
  surface: '#ffffff',
  surface2: '#f3ece0',
  text: '#1b1710',
  textDim: '#6b6252',
  textFaint: '#9b9280',
  accent: '#e89418', // marquee amber — "house light"
  accent2: '#ef5536', // = spark (back-compat alias, see note above)
  accentSoft: 'rgba(232,148,24,0.14)',
  onAccent: '#231300', // readable text/icon color when painted on top of `accent`
  spark: '#ef5536', // ticket-stub red-orange
  sparkSoft: 'rgba(239,85,54,0.12)',
  sparkInk: '#2b0a04',
  warn: '#e89418', // reuses signature amber — the crew-access/trial banners ARE the house light
  warnSoft: 'rgba(232,148,24,0.14)',
  success: '#19875a', // money-positive — reserved for literal currency figures
  successSoft: 'rgba(25,135,90,0.10)',
  danger: '#c23b2e', // money-negative — reserved for literal currency figures
  dangerSoft: 'rgba(194,59,46,0.10)',
  border: '#e4d9c6',
};

const darkColors = {
  bg: '#121016',
  surface: '#1b1820',
  surface2: '#242029',
  text: '#f3efe8',
  textDim: '#b2a99c',
  textFaint: '#756c60',
  accent: '#f6a723',
  accent2: '#ff6b4d', // = spark (back-compat alias, see note above)
  accentSoft: 'rgba(246,167,35,0.18)',
  onAccent: '#1a0f00', // dark-mode accent is light enough that dark text/icons read better than white
  spark: '#ff6b4d',
  sparkSoft: 'rgba(255,107,77,0.16)',
  sparkInk: '#200603',
  warn: '#f6a723',
  warnSoft: 'rgba(246,167,35,0.18)',
  success: '#3fcf98',
  successSoft: 'rgba(63,207,152,0.14)',
  danger: '#ec6a5a',
  dangerSoft: 'rgba(236,106,90,0.14)',
  border: '#332d3a',
};

export type ThemeColors = typeof lightColors;

type ThemeContextValue = {
  mode: ThemeMode;
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
  colors: ThemeColors;
  fonts: typeof fonts;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>('system');

  // Read the stored preference once on mount. Deliberately not gating
  // render on this resolving — defaulting to 'system' for one tick and
  // then reconciling is a smaller, less jarring gap than blocking the
  // whole app behind an extra AsyncStorage round trip.
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((stored) => {
      if (stored === 'light' || stored === 'dark' || stored === 'system') setPreferenceState(stored);
    });
  }, []);

  function setPreference(p: ThemePreference) {
    setPreferenceState(p);
    AsyncStorage.setItem(STORAGE_KEY, p).catch(() => {});
  }

  const mode: ThemeMode = preference === 'system' ? (systemScheme === 'light' ? 'light' : 'dark') : preference;
  const colors = mode === 'light' ? lightColors : darkColors;

  const value = useMemo(() => ({ mode, preference, setPreference, colors, fonts }), [mode, preference, colors]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
