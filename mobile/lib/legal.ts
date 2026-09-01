/**
 * Single source of truth for where the hosted Privacy Policy / Terms of
 * Service live — every in-app link (SettingsScreen, AuthScreen,
 * BillingScreen) points here instead of hardcoding the URL three times.
 *
 * Hosted via GitHub Pages, serving legal/privacy.html and legal/terms.html
 * straight from the repo (see legal/PRIVACY_POLICY.md's own header for the
 * draft-not-legal-advice caveat these still carry). Currently pointed at
 * the feature/billing-and-app-completeness branch's Pages deployment —
 * repoint to a main-branch deployment (Settings → Pages) once that branch
 * merges, so this URL doesn't depend on a feature branch staying alive.
 */
export const PRIVACY_POLICY_URL = 'https://lakeatrenae.github.io/TourMate/legal/privacy.html';
export const TERMS_OF_SERVICE_URL = 'https://lakeatrenae.github.io/TourMate/legal/terms.html';