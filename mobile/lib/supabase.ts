/**
 * Supabase client for the TourMate mobile app.
 *
 * SECURITY NOTES (read before touching this file):
 *
 * 1. This client is initialized with the `anon` key only. That key is safe
 *    to ship inside the app binary — it identifies the *project*, not a
 *    user, and grants no access by itself. Actual data access is enforced
 *    server-side by Postgres Row-Level Security (see
 *    supabase/migrations/0001_init.sql). Never import the `service_role`
 *    key into this app; it bypasses RLS entirely and belongs only in a
 *    trusted server environment.
 *
 * 2. Auth session tokens (access + refresh token) are persisted with
 *    `expo-secure-store`, which uses the iOS Keychain / Android Keystore —
 *    encrypted, sandboxed to this app. We deliberately do NOT use
 *    AsyncStorage for this, since AsyncStorage on Android is unencrypted
 *    plain-text storage — fine for non-sensitive cache data, not for auth
 *    tokens.
 *
 * 3. `react-native-url-polyfill` is required because supabase-js expects a
 *    browser-like `URL` global that React Native's JS engine doesn't
 *    provide out of the box. Import must happen before the client is
 *    created (see top of file).
 */
import 'react-native-url-polyfill/auto';

import { createClient, processLock } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { AppState, Platform } from 'react-native';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // Fail loudly at startup rather than silently making unauthenticated
  // requests to `undefined` — a misconfigured env is a config bug, not a
  // runtime state the app should try to limp through.
  throw new Error(
    'Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY. ' +
      'Copy .env.example to .env and fill in your Supabase project values.'
  );
}

/**
 * Adapter that lets supabase-js persist the auth session through
 * expo-secure-store instead of its browser-only default (localStorage).
 *
 * Note: SecureStore backs onto the OS keychain, which has a practical
 * per-item size ceiling (~2KB). A Supabase session (access + refresh
 * token) normally fits comfortably under that. If this ever starts
 * throwing size errors — e.g. after adding custom JWT claims — the fix is
 * to chunk the value across multiple SecureStore keys, not to fall back to
 * unencrypted storage.
 */
const SecureStoreAdapter = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};

/**
 * Web fallback. This app ships to iOS/Android — web is only ever a dev
 * convenience (`expo start --web`) — but Expo's web target still runs
 * this module, and expo-secure-store has no real Keychain/Keystore
 * equivalent in a browser to back onto. Using `localStorage` here matches
 * what supabase-js does by default on web; it's a strictly-dev-mode path,
 * never what ships to the App Store / Play Store.
 */
const WebStorageAdapter = {
  getItem: async (key: string) => (typeof localStorage === 'undefined' ? null : localStorage.getItem(key)),
  setItem: async (key: string, value: string) => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  },
  removeItem: async (key: string) => {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
  },
};

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: Platform.OS === 'web' ? WebStorageAdapter : SecureStoreAdapter,
    autoRefreshToken: true,
    persistSession: true,
    // The app, not a browser, drives navigation — detecting session info
    // in a URL (magic-link redirects on web) doesn't apply here.
    detectSessionInUrl: false,
    lock: processLock,
  },
});

/**
 * supabase-js's auto token refresh relies on being told when the app comes
 * back to the foreground; it doesn't poll on its own. Without this, a
 * session can go stale after the app sits backgrounded past the token's
 * expiry, and the next request fails instead of silently refreshing.
 */
AppState.addEventListener('change', (state) => {
  if (state === 'active') {
    supabase.auth.startAutoRefresh();
  } else {
    supabase.auth.stopAutoRefresh();
  }
});