/**
 * Auth context — the single source of truth for "who is signed in right
 * now" across the whole app. Every screen that needs the current user or
 * their profile reads it from here via `useAuth()` instead of calling
 * `supabase.auth` directly, so there's one consistent place session state
 * lives and updates.
 */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import * as Linking from 'expo-linking';

import { supabase } from './supabase';

/**
 * Mirrors the `profiles` table (see supabase/migrations/0001_init.sql and
 * 0006_profile_names.sql). Naming is split in two:
 *  - first_name/last_name: captured once at signup, the legal/formal name.
 *  - preferred_name: set later during profile completion — optional, and
 *    when present it's what the rest of the app should show.
 *  - display_name: NOT set directly — it's a generated column in Postgres
 *    (coalesce(preferred_name, first_name, full_name)), so every screen
 *    can just render `profile.display_name` without re-implementing that
 *    fallback logic itself.
 */
type Profile = {
  id: string;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  preferred_name: string | null;
  display_name: string;
  email: string;
  phone: string | null;
  avatar_url: string | null;
};

type AuthContextValue = {
  session: Session | null;
  profile: Profile | null;
  /** True until the initial session check completes — use this to show a
   *  splash/loading state instead of briefly flashing the sign-in screen
   *  for someone who's actually already logged in. */
  loading: boolean;
  signInWithPassword: (email: string, password: string) => Promise<{ error: string | null }>;
  signUp: (
    email: string,
    password: string,
    firstName: string,
    lastName: string
  ) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  /** Re-fetches the current user's profile row — call after updating it
   *  (e.g. setting a preferred name) so the rest of the app sees the change
   *  immediately instead of waiting for the next auth-state event. */
  refreshProfile: () => Promise<void>;
  /** True once Supabase has processed a password-recovery link and
   *  established a recovery session — RootNavigator uses this to force
   *  ResetPasswordScreen regardless of whatever else is going on. */
  passwordRecovery: boolean;
  requestPasswordReset: (email: string) => Promise<{ error: string | null }>;
  updatePassword: (newPassword: string) => Promise<{ error: string | null }>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const PROFILE_COLUMNS = 'id, full_name, first_name, last_name, preferred_name, display_name, email, phone, avatar_url';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [passwordRecovery, setPasswordRecovery] = useState(false);

  // Fetch (or clear) the profile row whenever the session's user changes.
  // Profiles are auto-created by the `handle_new_user` DB trigger on
  // signup (see 0004_tour_admin_roster_directory.sql), so by the time a
  // session exists there should always be a matching profile row.
  async function loadProfile(userId: string | undefined) {
    if (!userId) {
      setProfile(null);
      return;
    }
    const { data, error } = await supabase
      .from('profiles')
      .select(PROFILE_COLUMNS)
      .eq('id', userId)
      .single();

    if (error) {
      console.warn('Failed to load profile:', error.message);
      setProfile(null);
      return;
    }
    setProfile(data);
  }

  useEffect(() => {
    // On mount: check whether a session is already persisted (SecureStore —
    // see lib/supabase.ts) so a returning user skips the sign-in screen.
    supabase.auth.getSession().then(({ data: { session: initialSession } }) => {
      setSession(initialSession);
      loadProfile(initialSession?.user.id).finally(() => setLoading(false));
    });

    // Then keep listening for changes: sign in, sign out, token refresh —
    // and PASSWORD_RECOVERY, fired when the app opens a recovery link
    // (see requestPasswordReset's redirectTo) and Supabase establishes a
    // temporary recovery session from it.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, newSession) => {
      setSession(newSession);
      loadProfile(newSession?.user.id);
      if (event === 'PASSWORD_RECOVERY') setPasswordRecovery(true);
    });

    return () => subscription.unsubscribe();
  }, []);

  async function signInWithPassword(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    // Returning a plain string (not throwing) keeps error handling in the
    // calling screen simple — no try/catch required at every call site.
    return { error: error?.message ?? null };
  }

  async function signUp(email: string, password: string, firstName: string, lastName: string) {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        // Read by the `handle_new_user` trigger to set first_name/last_name
        // (and derive full_name) on the new profile row.
        data: { first_name: firstName, last_name: lastName },
      },
    });
    return { error: error?.message ?? null };
  }

  async function signOut() {
    setPasswordRecovery(false);
    await supabase.auth.signOut();
  }

  async function refreshProfile() {
    await loadProfile(session?.user.id);
  }

  async function requestPasswordReset(email: string) {
    // Linking.createURL builds a deep link back into this app —
    // `tourmate://reset-password` on native (see the "scheme" in
    // app.json), or the current origin + path in web dev. Supabase mails
    // a link that redirects here with a recovery token in the URL
    // fragment; opening it is what fires the PASSWORD_RECOVERY event
    // above.
    const redirectTo = Linking.createURL('reset-password');
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    return { error: error?.message ?? null };
  }

  async function updatePassword(newPassword: string) {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (!error) setPasswordRecovery(false);
    return { error: error?.message ?? null };
  }

  return (
    <AuthContext.Provider
      value={{
        session,
        profile,
        loading,
        signInWithPassword,
        signUp,
        signOut,
        refreshProfile,
        passwordRecovery,
        requestPasswordReset,
        updatePassword,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    // Fails fast if a screen forgets to render inside <AuthProvider>,
    // instead of silently returning undefined values that break later in
    // a confusing spot.
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}