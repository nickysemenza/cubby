import type { UserId } from "@cubby/schemas/identifiers";
import {
  connectedAppsOut,
  orphanedOAuthClientsOut,
  pruneOrphanedOAuthClientsOut,
  revokeConnectedAppInput,
  revokeConnectedAppOut,
} from "@cubby/schemas/oauth";
import type { z } from "zod";
import type { Database } from "~/server/db";
import {
  countOrphanedOAuthClients,
  listConnectedApps,
  pruneOrphanedOAuthClients,
  revokeConnectedApp,
} from "~/server/repo/oauth-consent";

export {
  connectedAppsOut,
  orphanedOAuthClientsOut,
  pruneOrphanedOAuthClientsOut,
  revokeConnectedAppInput,
  revokeConnectedAppOut,
};

export const listConnectedAppsWorkflow = async (db: Database, userId: UserId) =>
  await listConnectedApps(db, userId);

export const revokeConnectedAppWorkflow = async (
  db: Database,
  userId: UserId,
  input: z.input<typeof revokeConnectedAppInput>,
) => await revokeConnectedApp(db, userId, input.consentId);

export const countOrphanedOAuthClientsWorkflow = async (db: Database) =>
  await countOrphanedOAuthClients(db);

export const pruneOrphanedOAuthClientsWorkflow = async (db: Database) =>
  await pruneOrphanedOAuthClients(db);
