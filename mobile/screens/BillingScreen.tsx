/**
 * BillingScreen — the signed-in user's OWN individual subscription status.
 * No route params: this is never about "an organization's billing" anymore
 * — under the per-user model (0037_per_user_billing.sql) there's nothing
 * to look up but the caller's own profiles row, and nothing to gate on
 * (is_org_admin doesn't apply — everyone manages their own subscription).
 *
 * Crew/view-only access is free and unlimited forever. Owner/admin/manager
 * — anyone who needs to actually edit a tour — needs this subscription,
 * and it follows them across every org and tour they belong to, not just
 * one. A lapsed subscription doesn't lock anyone out; it soft-demotes them
 * to crew-level access (effective_tour_role) until they resubscribe.
 *
 * Checkout/Portal URLs (from create-checkout-session /
 * create-billing-portal-session) are opened via Linking.openURL — the
 * SYSTEM browser, never an in-app WebView — which is what keeps this app
 * clear of Apple/Google's in-app-purchase rules for a B2B subscription.
 * Stripe redirects back to `tourmate://billing` afterward (built the same
 * way auth-context.tsx's Linking.createURL('reset-password') is for the
 * password-recovery flow); this screen listens for that and re-fetches
 * status a few times over ~5s, since webhook delivery lands slightly
 * after the browser redirect, not before it.
 *
 * Theme (Manrope/JetBrains Mono, navy accent) per the "Load-In" design
 * review — see lib/theme.tsx.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from '../lib/legal';
import { useTheme, fonts, type ThemeColors } from '../lib/theme';

type MyBilling = {
  subscription_status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'none';
  trial_ends_at: string | null;
  subscription_interval: 'monthly' | 'annual' | null;
  stripe_customer_id: string | null;
};

export function BillingScreen() {
  const { session } = useAuth();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [billing, setBilling] = useState<MyBilling | null>(null);
  const [loading, setLoading] = useState(true);
  const [subscribing, setSubscribing] = useState<'monthly' | 'annual' | null>(null);
  const [managingBilling, setManagingBilling] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function load() {
    if (!session) return;
    const { data, error } = await supabase
      .from('profiles')
      .select('subscription_status, trial_ends_at, subscription_interval, stripe_customer_id')
      .eq('id', session.user.id)
      .single();
    if (error) {
      setErrorMessage(error.message);
      return;
    }
    setBilling(data as unknown as MyBilling);
  }

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load().finally(() => setLoading(false));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
  );

  // Catch the tourmate://billing return from Stripe Checkout/Portal and
  // re-poll status for a few seconds — the webhook that actually updates
  // the DB fires asynchronously, slightly after the browser redirect
  // lands here, not before it.
  const pollTimeouts = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => {
    function handleReturn(url: string) {
      if (!url.includes('billing')) return;
      setStatusMessage('Checking your subscription status…');
      [1000, 2500, 4500].forEach((delay) => {
        const t = setTimeout(() => {
          load().then(() => setStatusMessage(null));
        }, delay);
        pollTimeouts.current.push(t);
      });
    }

    const subscription = Linking.addEventListener('url', ({ url }) => handleReturn(url));
    Linking.getInitialURL().then((url) => {
      if (url) handleReturn(url);
    });

    return () => {
      subscription.remove();
      pollTimeouts.current.forEach(clearTimeout);
      pollTimeouts.current = [];
    };
  }, []);

  async function handleSubscribe(interval: 'monthly' | 'annual') {
    setErrorMessage(null);
    setSubscribing(interval);
    const { data, error } = await supabase.functions.invoke('create-checkout-session', {
      body: { interval },
    });
    setSubscribing(null);
    if (error || data?.error) {
      setErrorMessage(data?.error ?? error?.message ?? 'Failed to start checkout.');
      return;
    }
    await Linking.openURL(data.url);
  }

  async function handleManageBilling() {
    setErrorMessage(null);
    setManagingBilling(true);
    const { data, error } = await supabase.functions.invoke('create-billing-portal-session', {
      body: {},
    });
    setManagingBilling(false);
    if (error || data?.error) {
      setErrorMessage(data?.error ?? error?.message ?? 'Failed to open billing management.');
      return;
    }
    await Linking.openURL(data.url);
  }

  function statusLabel(): string {
    if (!billing) return '';
    if (billing.subscription_status === 'active') {
      return billing.subscription_interval === 'annual' ? 'Active — billed annually' : 'Active — billed monthly';
    }
    if (billing.subscription_status === 'trialing') {
      if (!billing.trial_ends_at) return 'Trial';
      const daysLeft = Math.ceil((new Date(billing.trial_ends_at).getTime() - Date.now()) / 86400000);
      return daysLeft > 0 ? `Trial — ${daysLeft} day${daysLeft === 1 ? '' : 's'} left` : 'Trial ended';
    }
    if (billing.subscription_status === 'past_due') return 'Payment failed — update your card to keep your access';
    if (billing.subscription_status === 'canceled') return 'Subscription canceled — you\'re on free crew access';
    return 'Free crew access';
  }

  const isActive =
    billing?.subscription_status === 'active' ||
    (billing?.subscription_status === 'trialing' &&
      !!billing.trial_ends_at &&
      new Date(billing.trial_ends_at).getTime() > Date.now());

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Billing</Text>
      <Text style={styles.subtitle}>Your subscription — follows you across every tour and organization.</Text>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}
      {statusMessage && <Text style={styles.statusMessage}>{statusMessage}</Text>}

      <View style={styles.statusCard}>
        <Text style={styles.statusLabel}>{statusLabel()}</Text>
        {!isActive && (
          <Text style={styles.statusHint}>
            You can still see and follow every tour you're part of — subscribe to add, edit, or manage.
          </Text>
        )}
      </View>

      {!isActive && (
        <>
          <Text style={styles.sectionTitle}>Professional</Text>
          <Pressable style={styles.planCard} onPress={() => handleSubscribe('monthly')} disabled={subscribing !== null}>
            <View>
              <Text style={styles.planName}>Monthly</Text>
              <Text style={styles.planPrice}>$74.99/month</Text>
            </View>
            {subscribing === 'monthly' && <ActivityIndicator color={colors.text} />}
          </Pressable>
          <Pressable style={styles.planCard} onPress={() => handleSubscribe('annual')} disabled={subscribing !== null}>
            <View>
              <Text style={styles.planName}>Annual</Text>
              <Text style={styles.planPrice}>$64.99/month — billed $779.88/yr</Text>
            </View>
            {subscribing === 'annual' && <ActivityIndicator color={colors.text} />}
          </Pressable>
          <Text style={styles.agreementText}>
            By subscribing you agree to our{' '}
            <Text style={styles.link} onPress={() => Linking.openURL(TERMS_OF_SERVICE_URL)}>
              Terms of Service
            </Text>{' '}
            and{' '}
            <Text style={styles.link} onPress={() => Linking.openURL(PRIVACY_POLICY_URL)}>
              Privacy Policy
            </Text>
            .
          </Text>
        </>
      )}

      {billing?.stripe_customer_id && (
        <Pressable style={styles.secondaryButton} onPress={handleManageBilling} disabled={managingBilling}>
          {managingBilling ? (
            <ActivityIndicator color={colors.accent} />
          ) : (
            <Text style={styles.secondaryButtonText}>Manage Billing</Text>
          )}
        </Pressable>
      )}
    </ScrollView>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    centered: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
    content: { padding: 20, paddingBottom: 60 },
    title: { color: colors.text, fontSize: 22, fontFamily: fonts.displayBold },
    subtitle: { color: colors.textDim, fontSize: 13, marginTop: 4, marginBottom: 16, lineHeight: 18, fontFamily: fonts.body },
    error: { color: colors.danger, fontSize: 13, marginBottom: 12, fontFamily: fonts.body },
    statusMessage: { color: colors.accent, fontSize: 13, marginBottom: 12, fontFamily: fonts.body },
    statusCard: { backgroundColor: colors.surface, borderRadius: 12, padding: 16, marginBottom: 20 },
    statusLabel: { color: colors.text, fontSize: 16, fontFamily: fonts.displaySemiBold },
    statusHint: { color: colors.textDim, fontSize: 12, marginTop: 6, lineHeight: 17, fontFamily: fonts.body },
    sectionTitle: { color: colors.textDim, fontSize: 12, fontFamily: fonts.bodySemiBold, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
    planCard: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: 10,
      padding: 16,
      marginBottom: 8,
      borderWidth: 1,
      borderColor: colors.border,
    },
    planName: { color: colors.text, fontSize: 15, fontFamily: fonts.displaySemiBold },
    planPrice: { color: colors.textDim, fontSize: 13, marginTop: 2, fontFamily: fonts.mono },
    agreementText: { color: colors.textFaint, fontSize: 12, marginTop: 4, marginBottom: 20, lineHeight: 17, fontFamily: fonts.body },
    link: { color: colors.accent },
    secondaryButton: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingVertical: 12,
      alignItems: 'center',
      marginBottom: 8,
    },
    secondaryButtonText: { color: colors.accent, fontSize: 14, fontFamily: fonts.bodySemiBold },
  });
}
