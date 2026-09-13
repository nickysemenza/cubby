import { z } from "zod";

export const revokeConnectedAppInput = z.object({ consentId: z.string() });

export const connectedAppOut = z.object({
  consentId: z.string(),
  clientId: z.string(),
  name: z.string().nullable(),
  uri: z.string().nullable(),
  scopes: z.array(z.string()),
  grantedAt: z.date().nullable(),
  /** Live (unrevoked, unexpired) refresh tokens — i.e. can it still get in. */
  activeTokens: z.number(),
  /**
   * Newest refresh token, which stands in for "last used": the token endpoint
   * rotates the refresh token on every use, so a fresh row means recent
   * activity. Without it, several connect attempts from the same client are
   * indistinguishable and there's no way to tell which one is still live.
   */
  lastActiveAt: z.date().nullable(),
});
export type ConnectedApp = z.infer<typeof connectedAppOut>;

export const connectedAppsOut = z.array(connectedAppOut);
export const revokeConnectedAppOut = z.object({ revoked: z.boolean() });
export const orphanedOAuthClientsOut = z.number();
export const pruneOrphanedOAuthClientsOut = z.object({
  deleted: z.array(z.string()),
});
