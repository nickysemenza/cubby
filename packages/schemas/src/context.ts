import { z } from "zod";
import type { UserId } from "./identifiers";

/**
 * Source of an action for audit logging
 */
export const auditSourceSchema = z.enum([
  "ui",
  "csv_import",
  "sheets_import",
  "api",
]);
export type AuditSource = z.infer<typeof auditSourceSchema>;

/**
 * Context representing who is performing an action.
 */
export interface ActorContext {
  userId: UserId;
  source: AuditSource;
}

/**
 * Build an ActorContext with the given values.
 * Source defaults to "ui" for standard web requests.
 */
export function buildActorContext(
  userId: UserId,
  source: AuditSource = "ui",
): ActorContext {
  return { userId, source };
}
