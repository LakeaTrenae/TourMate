/**
 * Single source of truth for where the hosted Privacy Policy / Terms of
 * Service live — every in-app link (SettingsScreen, AuthScreen,
 * BillingScreen) points here instead of hardcoding the URL three times.
 *
 * PLACEHOLDER until the docs in /legal are actually published (GitHub
 * Pages or similar — see legal/PRIVACY_POLICY.md's own header). Update
 * both constants the moment a real hosted URL exists; nothing else in
 * the app needs to change.
 */
export const PRIVACY_POLICY_URL = 'https://example.com/privacy';
export const TERMS_OF_SERVICE_URL = 'https://example.com/terms';
