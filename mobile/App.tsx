/**
 * App.tsx — root component. Owns the top-level navigation shell: which
 * screen stack renders depends entirely on whether AuthProvider has a
 * session, not on any manually-managed "isLoggedIn" flag.
 */
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, View } from 'react-native';

import { AuthProvider, useAuth } from './lib/auth-context';
import { AuthScreen } from './screens/AuthScreen';
import { ResetPasswordScreen } from './screens/ResetPasswordScreen';
import { CompleteProfileScreen } from './screens/CompleteProfileScreen';
import { TourListScreen } from './screens/TourListScreen';
import { TourDashboardScreen } from './screens/TourDashboardScreen';
import { TravelScreen } from './screens/TravelScreen';
import { AddFlightScreen } from './screens/AddFlightScreen';
import { LodgingScreen } from './screens/LodgingScreen';
import { AddLodgingScreen } from './screens/AddLodgingScreen';
import { CreateOrganizationScreen } from './screens/CreateOrganizationScreen';
import { CreateTourScreen } from './screens/CreateTourScreen';
import { AddTourDateScreen } from './screens/AddTourDateScreen';
import { ImportScheduleScreen } from './screens/ImportScheduleScreen';
import { GuestListScreen } from './screens/GuestListScreen';
import { AddGuestRequestScreen } from './screens/AddGuestRequestScreen';
import { DocumentsScreen } from './screens/DocumentsScreen';
import { AddDocumentScreen } from './screens/AddDocumentScreen';
import { BudgetScreen } from './screens/BudgetScreen';
import { AddBudgetItemScreen } from './screens/AddBudgetItemScreen';
import { ManageTeamScreen } from './screens/ManageTeamScreen';
import { InviteMemberScreen } from './screens/InviteMemberScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { DirectoryScreen } from './screens/DirectoryScreen';
import { ChecklistsScreen } from './screens/ChecklistsScreen';
import { AddChecklistScreen } from './screens/AddChecklistScreen';
import { ChecklistDetailScreen } from './screens/ChecklistDetailScreen';
import { VenuesScreen } from './screens/VenuesScreen';
import { AddVenueScreen } from './screens/AddVenueScreen';
import { PassportVisaScreen } from './screens/PassportVisaScreen';
import { GroundTransportScreen } from './screens/GroundTransportScreen';
import { AddGroundTransportScreen } from './screens/AddGroundTransportScreen';
import { ShowDetailScreen } from './screens/ShowDetailScreen';
import { AdvanceScreen } from './screens/AdvanceScreen';
import { SettlementScreen } from './screens/SettlementScreen';
import { RouteScreen } from './screens/RouteScreen';
import { SeasonScreen } from './screens/SeasonScreen';
import type { RootStackParamList } from './navigation/types';

const Stack = createNativeStackNavigator<RootStackParamList>();

function RootNavigator() {
  const { session, profile, loading, passwordRecovery } = useAuth();

  // Two things can make us show a spinner instead of real content:
  // the initial session check (`loading`), and — separately — having a
  // session but the profile row hasn't come back from Supabase yet.
  // Without the second check, there'd be a flash of the wrong screen
  // between "signed in" and "we know whether they've set a preferred name."
  if (loading || (session && !profile)) {
    return (
      <View style={{ flex: 1, backgroundColor: '#0b0b0f', alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  // preferred_name is '' (not null) once someone has been through this
  // screen, whether they set a name or explicitly skipped — see
  // CompleteProfileScreen. null means they've never seen it yet.
  const needsProfileCompletion = session && profile && profile.preferred_name === null;

  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      {passwordRecovery ? (
        // Checked before everything else — a recovery link can land here
        // whether or not there was already a session (a returning user
        // resetting their password mid-session should still hit this,
        // not their normal tour list).
        <Stack.Screen name="ResetPassword" component={ResetPasswordScreen} />
      ) : !session ? (
        <Stack.Screen name="Auth" component={AuthScreen} />
      ) : needsProfileCompletion ? (
        <Stack.Screen name="CompleteProfile" component={CompleteProfileScreen} />
      ) : (
        <>
          <Stack.Screen name="TourList" component={TourListScreen} />
          <Stack.Screen
            name="TourDashboard"
            component={TourDashboardScreen}
            options={{ headerShown: true, title: '' }}
          />
          <Stack.Screen name="Travel" component={TravelScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="AddFlight" component={AddFlightScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="Lodging" component={LodgingScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="AddLodging" component={AddLodgingScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="CreateOrganization" component={CreateOrganizationScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="CreateTour" component={CreateTourScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="AddTourDate" component={AddTourDateScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="ImportSchedule" component={ImportScheduleScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="GuestList" component={GuestListScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="AddGuestRequest" component={AddGuestRequestScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="Documents" component={DocumentsScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="AddDocument" component={AddDocumentScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="Budget" component={BudgetScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="AddBudgetItem" component={AddBudgetItemScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="ManageTeam" component={ManageTeamScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="InviteMember" component={InviteMemberScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="Settings" component={SettingsScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="Directory" component={DirectoryScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="Checklists" component={ChecklistsScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="AddChecklist" component={AddChecklistScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="ChecklistDetail" component={ChecklistDetailScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="Venues" component={VenuesScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="AddVenue" component={AddVenueScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="PassportVisa" component={PassportVisaScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="GroundTransport" component={GroundTransportScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="AddGroundTransport" component={AddGroundTransportScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="ShowDetail" component={ShowDetailScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="Advance" component={AdvanceScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="Settlement" component={SettlementScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="Route" component={RouteScreen} options={{ headerShown: true, title: '' }} />
          <Stack.Screen name="Season" component={SeasonScreen} options={{ headerShown: true, title: '' }} />
        </>
      )}
    </Stack.Navigator>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <NavigationContainer>
        <RootNavigator />
      </NavigationContainer>
      <StatusBar style="auto" />
    </AuthProvider>
  );
}
