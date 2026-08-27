/**
 * Small display-formatting helpers shared by every screen that renders a
 * role or department value (ManageTeam, TourDashboard, Directory,
 * Checklists, InviteMember, ...) — kept in one place instead of each
 * screen re-implementing the same title-casing.
 */

export function formatRole(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function formatDepartment(department: string | null | undefined): string {
  if (!department || department === 'general') return 'General';
  return department
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
