/**
 * Push notification registration — requests permission, fetches this
 * device's Expo push token, and upserts it into `push_tokens` so
 * send-notification (edge function) can find it later. Best-effort
 * everywhere: called fire-and-forget after sign-in (see auth-context.tsx)
 * and again from a manual retry button on SettingsScreen, and every
 * failure mode (permission denied, running on a simulator, no EAS
 * project linked yet) resolves to `{ error }` rather than throwing —
 * this is a nice-to-have layered on top of the app, never something that
 * should block or crash a screen.
 *
 * Requires the app to be linked to an EAS project (`npx eas init`) for
 * `getExpoPushTokenAsync` to return a real token — without that, this
 * fails gracefully with a clear error message rather than a cryptic one.
 */
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';

import { supabase } from './supabase';

export async function registerForPushNotifications(userId: string): Promise<{ error: string | null }> {
  if (!Device.isDevice) {
    return { error: 'Push notifications require a physical device (not a simulator).' };
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== 'granted') {
    return { error: 'Notification permission was not granted.' };
  }

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) {
    return { error: 'No EAS project linked yet (run `npx eas init`) — push notifications need this to get a token.' };
  }

  try {
    const tokenResponse = await Notifications.getExpoPushTokenAsync({ projectId });
    const expoPushToken = tokenResponse.data;

    const { error } = await supabase.from('push_tokens').upsert(
      {
        user_id: userId,
        expo_push_token: expoPushToken,
        device_info: `${Device.osName ?? Platform.OS} · ${Device.modelName ?? 'unknown device'}`,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,expo_push_token' }
    );
    if (error) return { error: error.message };

    return { error: null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to register for push notifications.' };
  }
}
