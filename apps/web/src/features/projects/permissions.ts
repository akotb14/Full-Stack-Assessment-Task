'use client';

import { canManageProject, type OrganizationRole, type ProjectRole } from '@projectflow/shared';
import { useCurrentUser } from '@/features/auth/hooks';
import { useProject, useProjectMembers } from './hooks';

export interface ProjectPermissions {
  currentUserId: string | null;
  organizationRole: OrganizationRole | null;
  projectRole: ProjectRole | null;
  /** True for OWNER/ADMIN of the organization and for a project's PROJECT_MANAGER. */
  canManage: boolean;
  /** False while any of the underlying queries is still loading. */
  isResolved: boolean;
}

/**
 * Works out what the signed-in user may do on one project.
 *
 * This mirrors the API's own check rather than replacing it — the server is
 * still the only thing standing between a user and an action they should not
 * take. Knowing the answer client-side just means the UI can disable options
 * instead of offering them and then showing an error.
 */
export function useProjectPermissions(projectId: string): ProjectPermissions {
  const { data: currentUser } = useCurrentUser();
  const { data: project } = useProject(projectId);
  const { data: members } = useProjectMembers(projectId);

  const organizationRole =
    currentUser && project
      ? (currentUser.organizations.find(
          (organization) => organization.id === project.organization.id,
        )?.role ?? null)
      : null;

  const projectRole =
    currentUser && members
      ? (members.find((member) => member.user.id === currentUser.id)?.role ?? null)
      : null;

  return {
    currentUserId: currentUser?.id ?? null,
    organizationRole,
    projectRole,
    canManage: canManageProject(organizationRole, projectRole),
    isResolved: Boolean(currentUser && project && members),
  };
}
