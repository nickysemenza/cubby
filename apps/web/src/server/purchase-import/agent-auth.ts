import { signJWT, verifyJWT } from "better-auth/crypto";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { z } from "zod";

import { APP_ORIGIN, MCP_RESOURCE, OAUTH_ISSUER } from "~/lib/auth";
import type { Database } from "~/server/db";
import { oauthClient, oauthRefreshToken, session } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

export const PURCHASE_AGENT_OAUTH_CLIENT_ID = "cubby-purchase-agent";
const PURCHASE_AGENT_OAUTH_SOFTWARE_ID = "cubby-purchase-agent-v1";
export const PURCHASE_AGENT_OAUTH_COOKIE = "cubby_purchase_agent_oauth";
export const PURCHASE_AGENT_OAUTH_CALLBACK = `${APP_ORIGIN}/api/import/agent/oauth/callback`;

const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const DELEGATION_TTL_SECONDS = 5 * 60;

const oauthStateClaims = z.object({
  typ: z.literal("purchase-agent-oauth-state"),
  state: z.string().min(1),
  verifier: z.string().min(43),
  userId: z.string().min(1),
});

const delegationClaims = z.object({
  typ: z.literal("purchase-agent-delegation"),
  sub: z.string().min(1),
  azp: z.literal(PURCHASE_AGENT_OAUTH_CLIENT_ID),
  aud: z.literal(MCP_RESOURCE),
  iss: z.literal(`${OAUTH_ISSUER}/purchase-agent`),
  run_id: z.string().uuid(),
  grant_id: z.string().min(1),
  iat: z.number(),
  exp: z.number(),
});

export type PurchaseAgentDelegationClaims = z.infer<typeof delegationClaims>;

export async function ensurePurchaseAgentOAuthClient(database: Database) {
  const now = new Date();
  await getDb(database)
    .insert(oauthClient)
    .values({
      id: PURCHASE_AGENT_OAUTH_CLIENT_ID,
      clientId: PURCHASE_AGENT_OAUTH_CLIENT_ID,
      clientSecret: null,
      disabled: false,
      skipConsent: false,
      enableEndSession: false,
      subjectType: "public",
      scopes: ["openid", "profile", "email", "offline_access"],
      userId: null,
      createdAt: now,
      updatedAt: now,
      name: "Cubby Purchase Agent",
      uri: APP_ORIGIN,
      softwareId: PURCHASE_AGENT_OAUTH_SOFTWARE_ID,
      softwareVersion: "1",
      redirectUris: [PURCHASE_AGENT_OAUTH_CALLBACK],
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      public: true,
      type: "web",
      requirePKCE: true,
      referenceId: PURCHASE_AGENT_OAUTH_SOFTWARE_ID,
    })
    .onConflictDoUpdate({
      target: oauthClient.clientId,
      set: {
        disabled: false,
        redirectUris: [PURCHASE_AGENT_OAUTH_CALLBACK],
        scopes: ["openid", "profile", "email", "offline_access"],
        tokenEndpointAuthMethod: "none",
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
        public: true,
        requirePKCE: true,
        updatedAt: now,
      },
    });
}

export async function findActivePurchaseAgentGrant(
  database: Database,
  userId: string,
  grantId?: string,
) {
  const now = new Date();
  const [grant] = await getDb(database)
    .select({
      id: oauthRefreshToken.id,
      expiresAt: oauthRefreshToken.expiresAt,
      sessionId: oauthRefreshToken.sessionId,
    })
    .from(oauthRefreshToken)
    .innerJoin(
      session,
      and(
        eq(session.id, oauthRefreshToken.sessionId),
        gt(session.expiresAt, now),
      ),
    )
    .where(
      and(
        eq(oauthRefreshToken.clientId, PURCHASE_AGENT_OAUTH_CLIENT_ID),
        eq(oauthRefreshToken.userId, userId),
        ...(grantId ? [eq(oauthRefreshToken.id, grantId)] : []),
        isNull(oauthRefreshToken.revoked),
        or(
          isNull(oauthRefreshToken.expiresAt),
          gt(oauthRefreshToken.expiresAt, now),
        ),
      ),
    )
    .orderBy(desc(oauthRefreshToken.createdAt))
    .limit(1);
  return grant ?? null;
}

export async function createPurchaseAgentOAuthState(input: {
  state: string;
  verifier: string;
  userId: string;
  secret: string;
}) {
  return await signJWT(
    {
      typ: "purchase-agent-oauth-state",
      state: input.state,
      verifier: input.verifier,
      userId: input.userId,
    },
    input.secret,
    OAUTH_STATE_TTL_SECONDS,
  );
}

export async function verifyPurchaseAgentOAuthState(
  token: string,
  secret: string,
) {
  const claims = await verifyJWT(token, secret);
  const parsed = oauthStateClaims.safeParse(claims);
  return parsed.success ? parsed.data : null;
}

export async function issuePurchaseAgentDelegation(input: {
  runId: string;
  userId: string;
  grantId: string;
  secret: string;
}) {
  return await signJWT(
    {
      typ: "purchase-agent-delegation",
      sub: input.userId,
      azp: PURCHASE_AGENT_OAUTH_CLIENT_ID,
      aud: MCP_RESOURCE,
      iss: `${OAUTH_ISSUER}/purchase-agent`,
      run_id: input.runId,
      grant_id: input.grantId,
    },
    input.secret,
    DELEGATION_TTL_SECONDS,
  );
}

export async function verifyPurchaseAgentDelegation(
  token: string,
  secret: string,
): Promise<PurchaseAgentDelegationClaims | null> {
  const claims = await verifyJWT(token, secret);
  const parsed = delegationClaims.safeParse(claims);
  return parsed.success ? parsed.data : null;
}

export function purchaseAgentOAuthCookie(token: string, secure: boolean) {
  const attributes = [
    `${PURCHASE_AGENT_OAUTH_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/api/import/agent/oauth/callback",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${OAUTH_STATE_TTL_SECONDS}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearPurchaseAgentOAuthCookie(secure: boolean) {
  const attributes = [
    `${PURCHASE_AGENT_OAUTH_COOKIE}=`,
    "Path=/api/import/agent/oauth/callback",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function readCookie(request: Request, name: string): string | null {
  for (const pair of request.headers.get("cookie")?.split(";") ?? []) {
    const [key, ...value] = pair.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

export async function createPkcePair() {
  const bytes = crypto.getRandomValues(new Uint8Array(48));
  const verifier = base64Url(bytes);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
