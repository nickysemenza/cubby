import { z } from "zod";

export const revokeConnectedAppInput = z.object({ consentId: z.string() });

export const connectedAppOut = z.object({
  consentId: z.string(),
  clientId: z.string(),
  name: z.string().nullable(),
  uri: z.string().nullable(),
  scopes: z.array(z.string()),
  grantedAt: z.date().nullable(),
  activeTokens: z.number(),
  lastActiveAt: z.date().nullable(),
});

export const connectedAppsOut = z.array(connectedAppOut);
export const revokeConnectedAppOut = z.object({ revoked: z.boolean() });
export const orphanedOAuthClientsOut = z.number();
export const pruneOrphanedOAuthClientsOut = z.object({
  deleted: z.array(z.string()),
});
