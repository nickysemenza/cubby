import type { UserId } from "@cubby/schemas/identifiers";
import type { ConnectedApp } from "@cubby/schemas/oauth";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
} from "~/server/db/schema";
import { unwrapDb, withTransaction } from "~/server/repo/database-helpers";

/**
 * OAuth clients the user has granted access to — the MCP connectors
 * (claude.ai, Claude Code, …) that authorized against this instance.
 *
 * `@daveyplate/better-auth-ui` has no view for these at the pinned version, so
 * this backs a custom "connected apps" page. It reads the oauth-provider
 * plugin's own tables directly rather than proxying its endpoints, because a
 * real revoke has to touch tokens the plugin's `delete-consent` leaves alone
 * (see {@link revokeConnectedApp}).
 */

/** Newest refresh token per (client, user) — see `ConnectedApp.lastActiveAt`. */
const lastActiveExpr = sql<Date | null>`(
  select max(${oauthRefreshToken.createdAt}) from ${oauthRefreshToken}
  where ${oauthRefreshToken.clientId} = ${oauthConsent.clientId}
    and ${oauthRefreshToken.userId} = ${oauthConsent.userId}
)`;

export async function listConnectedApps(
  db: Database,
  userId: UserId,
): Promise<ConnectedApp[]> {
  const rows = await unwrapDb(db)
    .select({
      consentId: oauthConsent.id,
      clientId: oauthConsent.clientId,
      name: oauthClient.name,
      uri: oauthClient.uri,
      scopes: oauthConsent.scopes,
      grantedAt: oauthConsent.createdAt,
      activeTokens: sql<number>`(
        select count(*)::int from ${oauthRefreshToken}
        where ${oauthRefreshToken.clientId} = ${oauthConsent.clientId}
          and ${oauthRefreshToken.userId} = ${oauthConsent.userId}
          and ${oauthRefreshToken.revoked} is null
          and (${oauthRefreshToken.expiresAt} is null or ${oauthRefreshToken.expiresAt} > now())
      )`,
      lastActiveAt: lastActiveExpr,
    })
    .from(oauthConsent)
    .leftJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .where(eq(oauthConsent.userId, userId))
    // Most recently active first: with several attempts from the same client,
    // the live one is the top row and the stale duplicates sink.
    .orderBy(
      sql`${lastActiveExpr} desc nulls last`,
      desc(oauthConsent.createdAt),
    );

  return rows.map((row) => ({
    ...row,
    scopes: row.scopes ?? [],
  }));
}

/**
 * Actually revoke an app's access.
 *
 * The plugin's own `/oauth2/delete-consent` deletes only the consent row, which
 * would leave the client's refresh token live — it could keep minting access
 * tokens indefinitely and the "revoke" button would be a lie. So this drops the
 * consent *and* kills every credential, in one transaction.
 *
 * Dynamically-registered clients (every MCP connector — they self-register via
 * RFC 7591 and have no owner) are deleted outright once nobody consents to
 * them; a re-connect simply registers a fresh one. Clients with an owner are
 * left in place, since those were created deliberately.
 */
export async function revokeConnectedApp(
  db: Database,
  userId: UserId,
  consentId: string,
): Promise<{ revoked: boolean }> {
  return withTransaction(db, async (tx) => {
    const [consent] = await tx
      .select({ clientId: oauthConsent.clientId })
      .from(oauthConsent)
      .where(
        and(eq(oauthConsent.id, consentId), eq(oauthConsent.userId, userId)),
      )
      .limit(1);

    // Not found, or not this user's — same answer either way, so a guessed id
    // can't distinguish the two.
    if (!consent) return { revoked: false };

    const { clientId } = consent;

    // Delete the credentials outright rather than stamping `revoked`. Both stop
    // the client dead (a token that isn't in the table fails lookup), but a
    // surviving row would block the client cleanup below: oauth_refresh_token
    // and oauth_access_token carry plain no-action FKs to oauth_client.clientId,
    // so deleting a client that still has token rows raises a constraint
    // violation and rolls back the whole revoke.
    await tx
      .delete(oauthAccessToken)
      .where(
        and(
          eq(oauthAccessToken.clientId, clientId),
          eq(oauthAccessToken.userId, userId),
        ),
      );
    await tx
      .delete(oauthRefreshToken)
      .where(
        and(
          eq(oauthRefreshToken.clientId, clientId),
          eq(oauthRefreshToken.userId, userId),
        ),
      );
    await tx.delete(oauthConsent).where(eq(oauthConsent.id, consentId));

    // Only drop the client once nothing at all references it — another user's
    // consent or leftover tokens would both make the delete fail. Anything left
    // behind is picked up later by pruneOrphanedOAuthClients.
    const [remaining] = await tx
      .select({
        refs: sql<number>`(
          (select count(*) from ${oauthConsent} where ${oauthConsent.clientId} = ${clientId})
          + (select count(*) from ${oauthRefreshToken} where ${oauthRefreshToken.clientId} = ${clientId})
          + (select count(*) from ${oauthAccessToken} where ${oauthAccessToken.clientId} = ${clientId})
        )::int`,
      })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, clientId))
      .limit(1);

    if ((remaining?.refs ?? 1) === 0) {
      await tx
        .delete(oauthClient)
        .where(
          and(eq(oauthClient.clientId, clientId), isNull(oauthClient.userId)),
        );
    }

    return { revoked: true };
  });
}

/**
 * Delete self-registered OAuth clients that nobody has consented to and that
 * hold no tokens.
 *
 * Every abandoned connect attempt leaves a client row behind — dynamic client
 * registration happens before the user ever reaches the consent screen, so a
 * few failed attempts pile up quickly. Only unowned (dynamically registered)
 * clients are eligible; a client with an owner was created on purpose.
 */
export async function pruneOrphanedOAuthClients(
  db: Database,
): Promise<{ deleted: string[] }> {
  const deleted = await unwrapDb(db)
    .delete(oauthClient)
    .where(orphanedClient)
    .returning({ clientId: oauthClient.clientId });

  return { deleted: deleted.map((row) => row.clientId) };
}

export async function countOrphanedOAuthClients(db: Database): Promise<number> {
  const [row] = await unwrapDb(db)
    .select({ count: sql<number>`count(*)::int` })
    .from(oauthClient)
    .where(orphanedClient);

  return row?.count ?? 0;
}

/** Unowned, unconsented, and holding no tokens — safe to delete. */
const orphanedClient = and(
  isNull(oauthClient.userId),
  sql`not exists (select 1 from ${oauthConsent} where ${oauthConsent.clientId} = ${oauthClient.clientId})`,
  sql`not exists (select 1 from ${oauthRefreshToken} where ${oauthRefreshToken.clientId} = ${oauthClient.clientId})`,
  sql`not exists (select 1 from ${oauthAccessToken} where ${oauthAccessToken.clientId} = ${oauthClient.clientId})`,
);
