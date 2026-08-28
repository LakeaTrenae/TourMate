/**
 * BillingScreen — one organization's subscription status, reachable
 * either from TourListScreen's "🔒 Billing needed" banner (a locked org)
 * or, for an active org, as a normal management screen. Role-aware in a
 * single screen rather than a separate lock-screen component: owners/
 * admins get the full subscribe/manage/sync-seats UI, everyone else gets
 * a read-only status + "ask your owner or admin" message — mirrors this
 * app's usual philosophy of showing the controls to whoever can act and
 * letting RLS (is_org_admin, checked both here and inside every billing
 * edge function) be the real guard, not this screen's own role check.
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
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth-context';
import { PRIVACY_POLICY_URL, TERMS_OF_SERVICE_URL } from '../lib/legal';
import type { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Billing'>;

type OrgBilling = {
  subscription_status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'none';
  trial_ends_at: string | null;
  subscription_renews_at: string | null;
  subscription_interval: 'monthly' | 'annual' | null;
  billing_customer_id: string | null;
};

export function BillingScreen({ route }: Props) {
  const { organizationId, organizationName } = route.params;
  const { session } = useAuth();

  const [org, setOrg] = useState<OrgBilling | null>(null);
  const [seatCount, setSeatCount] = useState<number | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [subscribing, setSubscribing] = useState<'monthly' | 'annual' | null>(null);
  const [managingBilling, setManagingBilling] = useState(false);
  const [syncingSeats, setSyncingSeats] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function load() {
    if (!session) return;
    const [orgRes, seatRes, adminRes] = await Promise.all([
      supabase
        .from('organizations')
        .select('subscription_status, trial_ends_at, subscription_renews_at, subscription_interval, billing_customer_id')
        .eq('id', organizationId)
        .single(),
      supabase.rpc('compute_org_seat_count', { p_org_id: organizationId }),
      supabase.rpc('is_org_admin', { p_org_id: organizationId, p_user_id: session.user.id }),
    ]);
    if (orgRes.error) {
      setErrorMessage(orgRes.error.message);
      return;
    }
    setOrg(orgRes.data as unknown as OrgBilling);
    setSeatCount(seatRes.data ?? null);
    setIsAdmin(!!adminRes.data);
  }

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load().finally(() => setLoading(false));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [organizationId])
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId]);

  async function handleSubscribe(interval: 'monthly' | 'annual') {
    setErrorMessage(null);
    setSubscribing(interval);
    const { data, error } = await supabase.functions.invoke('create-checkout-session', {
      body: { orgId: organizationId, interval },
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
      body: { orgId: organizationId },
    });
    setManagingBilling(false);
    if (error || data?.error) {
      setErrorMessage(data?.error ?? error?.message ?? 'Failed to open billing management.');
      return;
    }
    await Linking.openURL(data.url);
  }

  async function handleSyncSeats() {
    setErrorMessage(null);
    setSyncingSeats(true);
    const { data, error } = await supabase.functions.invoke('sync-org-seats', {
      body: { orgId: organizationId },
    });
    setSyncingSeats(false);
    if (error || data?.error) {
      setErrorMessage(data?.error ?? error?.message ?? 'Failed to sync seats.');
      return;
    }
    setStatusMessage(`Synced — ${data.seatCount} seat${data.seatCount === 1 ? '' : 's'} on Stripe.`);
    await load();
  }

  function statusLabel(): string {
    if (!org) return '';
    if (org.subscription_status === 'active') {
      return org.subscription_renews_at
        ? `Active — renews ${new Date(org.subscription_renews_at).toLocaleDateString()}`
        : 'Active';
    }
    if (org.subscription_status === 'trialing') {
      if (!org.trial_ends_at) return 'Trial';
      const daysLeft = Math.ceil((new Date(org.trial_ends_at).getTime() - Date.now()) / 86400000);
      return daysLeft > 0 ? `Trial — ${daysLeft} day${daysLeft === 1 ? '' : 's'} left` : 'Trial ended';
    }
    if (org.subscription_status === 'past_due') return 'Payment failed — update your card to keep access';
    if (org.subscription_status === 'canceled') return 'Subscription canceled';
    return 'No active subscription';
  }

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Billing</Text>
      <Text style={styles.subtitle}>{organizationName}</Text>

      {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}
      {statusMessage && <Text style={styles.statusMessage}>{statusMessage}</Text>}

      <View style={styles.statusCard}>
        <Text style={styles.statusLabel}>{statusLabel()}</Text>
        {seatCount !== null && <Text style={styles.seatLabel}>{seatCount} seat{seatCount === 1 ? '' : 's'}</Text>}
      </View>

      {isAdmin ? (
        <>
          <Text style={styles.sectionTitle}>Choose a plan</Text>
          <Pressable
            style={styles.planCard}
            onPress={() => handleSubscribe('monthly')}
            disabled={subscribing !== null}
          >
            <View>
              <Text style={styles.planName}>Monthly</Text>
              <Text style={styles.planPrice}>$39.99 / seat / month</Text>
            </View>
            {subscribing === 'monthly' && <ActivityIndicator color="#fff" />}
          </Pressable>
          <Pressable
            style={styles.planCard}
            onPress={() => handleSubscribe('annual')}
            disabled={subscribing !== null}
          >
            <View>
              <Text style={styles.planName}>Annual</Text>
              <Text style={styles.planPrice}>$34.99 / seat / month — billed $419.88/yr</Text>
            </View>
            {subscribing === 'annual' && <ActivityIndicator color="#fff" />}
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

          {org?.billing_customer_id && (
            <>
              <Pressable style={styles.secondaryButton} onPress={handleManageBilling} disabled={managingBilling}>
                {managingBilling ? (
                  <ActivityIndicator color="#7c9cff" />
                ) : (
                  <Text style={styles.secondaryButtonText}>Manage Billing</Text>
                )}
              </Pressable>
              <Pressable style={styles.secondaryButton} onPress={handleSyncSeats} disabled={syncingSeats}>
                {syncingSeats ? (
                  <ActivityIndicator color="#7c9cff" />
                ) : (
                  <Text style={styles.secondaryButtonText}>Sync Seats</Text>
                )}
              </Pressable>
            </>
          )}
        </>
      ) : (
        <Text style={styles.nonAdminHint}>
          Ask your organization's owner or admin to renew billing to restore access.
        </Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b0b0f' },
  centered: { flex: 1, backgroundColor: '#0b0b0f', alignItems: 'center', justifyContent: 'center' },
  content: { padding: 20, paddingBottom: 60 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700' },
  subtitle: { color: '#6b6b76', fontSize: 13, marginTop: 4, marginBottom: 16 },
  error: { color: '#ff6b6b', fontSize: 13, marginBottom: 12 },
  statusMessage: { color: '#7c9cff', fontSize: 13, marginBottom: 12 },
  statusCard: { backgroundColor: '#1a1a20', borderRadius: 12, padding: 16, marginBottom: 20 },
  statusLabel: { color: '#fff', fontSize: 16, fontWeight: '600' },
  seatLabel: { color: '#9a9aa5', fontSize: 13, marginTop: 4 },
  sectionTitle: { color: '#9a9aa5', fontSize: 12, fontWeight: '600', textTransform: 'uppercase', marginBottom: 8 },
  planCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#1a1a20',
    borderRadius: 10,
    padding: 16,
    marginBottom: 8,
  },
  planName: { color: '#fff', fontSize: 15, fontWeight: '600' },
  planPrice: { color: '#9a9aa5', fontSize: 13, marginTop: 2 },
  agreementText: { color: '#6b6b76', fontSize: 12, marginTop: 4, marginBottom: 20, lineHeight: 17 },
  link: { color: '#7c9cff' },
  secondaryButton: {
    borderWidth: 1,
    borderColor: '#2a2a32',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    marginBottom: 8,
  },
  secondaryButtonText: { color: '#7c9cff', fontSize: 14, fontWeight: '600' },
  nonAdminHint: { color: '#9a9aa5', fontSize: 14, lineHeight: 20 },
});
