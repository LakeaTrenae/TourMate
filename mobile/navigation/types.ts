/**
 * Central definition of every screen + the params it expects. Importing
 * this one type everywhere (instead of each screen inventing its own
 * params shape) is what lets `navigation.navigate('TourDashboard', {...})`
 * calls get type-checked against what TourDashboardScreen actually reads.
 */
export type RootStackParamList = {
  Auth: undefined;
  CompleteProfile: undefined;
  ResetPassword: undefined;
  MfaChallenge: undefined;
  TourList: undefined;
  TourDashboard: { tourId: string; tourName: string };
  Travel: { tourId: string; tourName: string };
  AddFlight: { tourId: string };
  Lodging: { tourId: string; tourName: string };
  AddLodging: { tourId: string };
  CreateOrganization: undefined;
  CreateTour: { organizationId: string };
  AddTourDate: { tourId: string };
  ImportSchedule: { tourId: string };
  GuestList: { tourId: string; tourName: string };
  AddGuestRequest: { tourId: string };
  Documents: { tourId: string; tourName: string };
  AddDocument: { tourId: string };
  Budget: { tourId: string; tourName: string };
  AddBudgetItem: { tourId: string };
  ManageTeam: { tourId: string; tourName: string };
  InviteMember: { tourId: string };
  Settings: undefined;
  Directory: { tourId: string; tourName: string };
  Checklists: { tourId: string; tourName: string };
  AddChecklist: { tourId: string };
  ChecklistDetail: { checklistId: string; tourId: string; title: string };
  ChecklistSharing: { checklistId: string; tourId: string; checklistTitle: string };
  Venues: { organizationId: string; organizationName: string };
  AddVenue: { organizationId: string; venueId?: string };
  GroundTransport: { tourId: string; tourName: string };
  AddGroundTransport: { tourId: string };
  ShowDetail: { tourId: string; tourDateId: string };
  Advance: { tourId: string; tourDateId: string; tourDateLabel: string };
  AdvanceSharing: { advanceId: string; tourId: string; advanceLabel: string };
  Settlement: { tourId: string; tourDateId: string; tourDateLabel: string };
  Season: undefined;
  Route: { tourId: string; tourName: string };
  Billing: { organizationId: string; organizationName: string };
  PassportVisa: { targetUserId?: string; targetName?: string };
  EmergencyContact: { targetUserId?: string; targetName?: string };
  Artists: { tourId: string; tourName: string };
  ArtistDetail: { artistId: string; tourId: string; artistName: string };
  DocumentSharing: { documentId: string; tourId: string; docTitle: string };
  ViewDocument: { bucket: string; storagePath: string; title: string };
  AuditLog: { tourId: string; tourName: string };
  TourExport: { tourId: string; tourName: string };
};