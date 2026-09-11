/** Role a user holds inside an organization. */
export enum OrganizationRole {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  MEMBER = 'MEMBER',
}

/** Role a user holds inside a single project. */
export enum ProjectRole {
  PROJECT_MANAGER = 'PROJECT_MANAGER',
  MEMBER = 'MEMBER',
}

export const ORGANIZATION_ROLES = Object.values(OrganizationRole);
export const PROJECT_ROLES = Object.values(ProjectRole);

/** Organization roles that grant access to every project in the organization. */
export const ELEVATED_ORGANIZATION_ROLES: readonly OrganizationRole[] = [
  OrganizationRole.OWNER,
  OrganizationRole.ADMIN,
];

export function isElevatedOrganizationRole(role: OrganizationRole | null | undefined): boolean {
  return role != null && ELEVATED_ORGANIZATION_ROLES.includes(role);
}

/**
 * Whether a user may manage a project: change its configuration and membership,
 * and assign its tasks to anyone rather than only to themselves.
 *
 * The rule deliberately spans both levels — an elevated organization role
 * grants it everywhere, a PROJECT_MANAGER role grants it on one project. It
 * lives here so the API and the web client cannot drift apart on who is
 * allowed to do what. The API remains the enforcement point; the client uses
 * it only to avoid offering actions that would be rejected.
 */
export function canManageProject(
  organizationRole: OrganizationRole | null | undefined,
  projectRole: ProjectRole | null | undefined,
): boolean {
  return isElevatedOrganizationRole(organizationRole) || projectRole === ProjectRole.PROJECT_MANAGER;
}
