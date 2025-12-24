/**
 * Organization repository functions.
 * All direct database operations for the organization table.
 */

import { eq } from "drizzle-orm";
import { type OrganizationId } from "~/schemas/identifiers";
import { type Database } from "~/server/db";
import { organization } from "~/server/db/auth.schema";
import { getDb } from "./database-helpers";

/**
 * Get organization metadata by organization ID.
 * Returns the raw metadata string (JSON) or null if not set.
 */
export const getOrganizationMetadata = async (
  db: Database,
  organizationId: OrganizationId,
): Promise<{ metadata: string | null } | undefined> => {
  return getDb(db).query.organization.findFirst({
    where: eq(organization.id, organizationId),
    columns: { metadata: true },
  });
};

/**
 * Update organization metadata.
 * The metadata should be a JSON string.
 */
export const updateOrganizationMetadata = async (
  db: Database,
  organizationId: OrganizationId,
  metadata: string,
): Promise<void> => {
  await getDb(db)
    .update(organization)
    .set({ metadata })
    .where(eq(organization.id, organizationId));
};
