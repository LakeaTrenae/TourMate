/**
 * theme.tsx — the Fraunces / Manrope / JetBrains Mono + navy design
 * system approved via the "Load-In" design review (list-heavy screens:
 * TourList, Venues, Artists, Documents, Checklists, GuestList). One
 * ThemeProvider wraps the app (App.tsx) and every converted screen reads
 * colors/fonts from useTheme() instead of hardcoding hex values — a
 * future palette or type change becomes a one-file edit, not a
 * grep-and-replace across a dozen StyleSheets.
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
// One family (Manrope) carries both display and body now — Fraunces read
// heavy/clunky at real UI sizes once it was actually on screen rather
// than in a polished static mockup, so it's out. Every screen reads
// these semantic names, never a literal font string, so a future swap
// is this one file, not six.
export const fonts = {
  displayBlack: 'Manrope_800ExtraBold', // page-level titles
  displayBold: 'Manrope_700Bold', // section/emphasis headers
  displaySemiBold: 'Manrope_600SemiBold', // card titles
  displayItalic: 'Manrope_600SemiBold', // no italic cut in this family — falls back to upright
  body: 'Manrope_400Regular',
  bodyMedium: 'Manrope_500Medium',
  bodySemiBold: 'Manrope_600SemiBold',
  bodyBold: 'Manrope_700Bold',
  mono: 'JetBrainsMono_400Regular',
  monoMedium: 'JetBrainsMono_500Medium',
};

const lightColors = {
  bg: '#f6f7f9',
  surface: '#ffffff',
  surface2: '#eceef2',
  text: '#141821',
  textDim: '#666c78',
  textFaint: '#9aa0aa',
  accent: '#1c3a5e',
  accent2: '#2f5686',
  accentSoft: 'rgba(28,58,94,0.08)',
  onAccent: '#ffffff', // readable text/icon color when painted on top of `accent`
  warn: '#a86a1e',
  warnSoft: 'rgba(168,106,30,0.12)',
  success: '#1f8a5f',
  successSoft: 'rgba(31,138,95,0.1)',
  danger: '#b3261e',
  dangerSoft: 'rgba(179,38,30,0.1)',
  border: '#e3e5ea',
};

const darkColors = {
  bg: '#0b0e13',
  surface: '#151920',
  surface2: '#1a1f28',
  text: '#f0f2f5',
  textDim: '#8d94a0',
  textFaint: '#5f6570',
  accent: '#5b93cf',
  accent2: '#3a6a9e',
  accentSoft: 'rgba(91,147,207,0.16)',
  onAccent: '#0b0e13', // dark-mode accent is light enough that dark text/icons read better than white
  warn: '#e0a545',
  warnSoft: 'rgba(224,165,69,0.15)',
  success: '#4fd192',
  successSoft: 'rgba(79,209,146,0.14)',
  danger: '#ff6b6b',
  dangerSoft: 'rgba(255,107,107,0.12)',
  border: '#242932',
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
