import { type UserId, userId } from "@cubby/schemas/identifiers";
import { getErrorMessage } from "@cubby/shared";
import type { verifyJwsAccessToken } from "better-auth/oauth2";
import { z } from "zod";

const verifiedMcpClaimsSchema = z.object({
  sub: z.string().min(1).optional(),
  sid: z.string().optional(),
  azp: z.string().optional(),
  aud: z.union([z.string(), z.array(z.string())]).optional(),
});

const verifierErrorSchema = z.object({
  code: z.union([z.string(), z.number()]).optional(),
});

const unverifiedClaimsSchema = z.object({
  iss: z.json().optional(),
  aud: z.json().optional(),
  exp: z.json().optional(),
});

type VerifyOptions = Parameters<typeof verifyJwsAccessToken>[1];
type VerifiedMcpClaims = z.infer<typeof verifiedMcpClaimsSchema>;
type UnverifiedClaims = z.infer<typeof unverifiedClaimsSchema>;

export type McpAuthRejectionDetail =
  | { aud: VerifiedMcpClaims["aud"] }
  | {
      reason: string;
      code: string | number | undefined;
      claims: UnverifiedClaims | null;
    };

export type VerifyMcpAccessToken = (
  token: string,
  options: VerifyOptions,
) => Promise<VerifiedMcpClaims>;

export interface McpActor {
  userId: UserId;
  /** `sid` claim — the better-auth session the grant hangs off, if present. */
  sessionId: string | null;
  /** OAuth authorized-party claim; absent only on legacy access tokens. */
  clientId: string | null;
  /** Present only for the private purchase-agent delegation credential. */
  purchaseAgentRunId?: string;
  /** OAuth refresh-grant row that authorized the private delegation. */
  purchaseAgentGrantId?: string;
}

interface McpTokenVerifierDependencies {
  verifyAccessToken: VerifyMcpAccessToken;
  verificationOptions: VerifyOptions;
  reportRejection: (message: string, detail: McpAuthRejectionDetail) => void;
}

export function createMcpTokenVerifier({
  verifyAccessToken,
  verificationOptions,
  reportRejection,
}: McpTokenVerifierDependencies) {
  return async function verifyMcpToken(
    request: Request,
  ): Promise<McpActor | null> {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) return null;

    const token = authorization.slice("Bearer ".length).trim();
    if (!token) return null;

    try {
      const payload = verifiedMcpClaimsSchema.parse(
        await verifyAccessToken(token, verificationOptions),
      );
      if (!payload.sub) {
        reportRejection("[MCP auth] token has no subject", {
          aud: payload.aud,
        });
        return null;
      }
      return {
        userId: userId.parse(payload.sub),
        sessionId: payload.sid ?? null,
        clientId: payload.azp ?? null,
      };
    } catch (error) {
      const parsedError = verifierErrorSchema.safeParse(error);
      // Claims only—never the bearer token itself. This diagnostic reaches
      // `wrangler tail`; verification above remains the authorization decision.
      reportRejection("[MCP auth] token rejected", {
        reason: getErrorMessage(error),
        code: parsedError.success ? parsedError.data.code : undefined,
        claims: decodeUnverifiedClaims(token),
      });
      return null;
    }
  };
}

function decodeUnverifiedClaims(token: string) {
  const segments = token.split(".");
  if (segments.length !== 3 || !segments[1]) return null;

  try {
    const decoded = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(segments[1].replace(/-/g, "+").replace(/_/g, "/")),
          (character) => character.charCodeAt(0),
        ),
      ),
    );
    const claims = unverifiedClaimsSchema.safeParse(decoded);
    return claims.success ? claims.data : null;
  } catch {
    return null;
  }
}

export function createUnauthorizedResponse(resource: string) {
  const url = new URL(resource);
  const resourceMetadataUrl = `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;

  return function unauthorizedResponse() {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
      },
    });
  };
}
