import type { UserId, OrganizationId } from "./identifiers";

/**
 * Source of an action for audit logging
 */
type AuditSource = "ui" | "csv_import" | "sheets_import" | "api";

/**
 * Context representing who is performing an action.
 * All fields required - if you don't have all three,
 * the function probably shouldn't take ActorContext.
 */
export interface ActorContext {
  userId: UserId;
  organizationId: OrganizationId;
  source: AuditSource;
}

/**
 * Build an ActorContext with the given values.
 * Source defaults to "ui" for standard web requests.
 */
export function buildActorContext(
  userId: UserId,
  organizationId: OrganizationId,
  source: AuditSource = "ui",
): ActorContext {
  return { userId, organizationId, source };
}
