import type { AuditChannel } from "@cubby/schemas/context";
import { runEntityId, userId } from "@cubby/schemas/identifiers";

// Static on purpose, like request-context: a lazy auth import inside a Worker
// request left the purchase agent's MCP tool calls unanswered (#2536).
import { getAuth } from "~/lib/auth";
import { DECISION_DEADLINE_MS } from "~/server/ai/decision-model";
import { AppError } from "~/server/errors/app-error";
import { appleClientUpdateRequired } from "~/server/http/apple-client-gate";
import {
  authenticateHttpSession,
  type HttpSessionReader,
} from "~/server/http/http-session-cache";
import {
  type AuthenticatedRequestContext,
  createRequestContext,
  type RequestActor,
  requireActor,
} from "~/server/http/request-context";
import type { McpActor } from "~/server/mcp/auth-verifier";
import { withTrace } from "~/server/observability/tracing";

/**
 * The one authentication step every client passes before it reaches an
 * operation, a socket, or a credential exchange. An adapter names the
 * credentials its endpoint accepts and gets back a {@link Principal} or a
 * {@link Challenge} it renders in its own protocol; it never reads
 * credentials, origins, or client builds itself.
 */

/** A credential as the request presents it; exactly one is read per request. */
export type Credential = "cookie" | "bearer" | "api-key" | "mcp-token";

/** The client family a principal speaks for. */
export type Channel = "browser" | "native" | "cli" | "mcp" | "system";

export type AuthPolicy = {
  /**
   * The endpoint family: it fixes the audit channel (`web`, `api`, `mcp`) so a
   * hosted native WebView on a browser endpoint still audits as `web`, and it
   * decides how an `Authorization: Bearer` header is read.
   */
  readonly surface: "browser" | "api" | "mcp";
  readonly credentials: readonly Credential[];
  /** A credential exchange reads the stored session and leaves its expiry alone. */
  readonly freshSession?: true;
};

export const BROWSER_AUTH = {
  surface: "browser",
  credentials: ["cookie", "bearer"],
} as const satisfies AuthPolicy;

export const API_AUTH = {
  surface: "api",
  credentials: ["api-key", "bearer", "cookie"],
} as const satisfies AuthPolicy;

/** A native device socket: the app's session, never an API key. */
export const DEVICE_AUTH = {
  surface: "api",
  credentials: ["bearer", "cookie"],
} as const satisfies AuthPolicy;

/** Bearer → HttpOnly cookie for the hosted workspace; never an ambient cookie. */
export const NATIVE_SESSION_EXCHANGE_AUTH = {
  surface: "api",
  credentials: ["bearer"],
  freshSession: true,
} as const satisfies AuthPolicy;

export const MCP_AUTH = {
  surface: "mcp",
  credentials: ["mcp-token"],
} as const satisfies AuthPolicy;

/** The purchase agent's run-bound delegation, checked against its live grant. */
export type RunDelegation = {
  readonly runId: string;
  readonly grantId: string;
  /** Signed coordinator generation of the delegated tool call, when stamped. */
  readonly generation?: string | undefined;
};

/** `ClientIdentity.userAgent` in CubbyKit: `<product>/<version> (...)`. */
export type ClientBuild = {
  readonly product: string;
  readonly version: string;
  /** Set for an Apple app build older than the server's minimum. */
  readonly updateRequired: ReturnType<typeof appleClientUpdateRequired>;
};

export type DeadlineClass = "read" | "modelRead" | "write";

/**
 * The wall clock one call under a principal may take, by deadline class. A
 * composite unit (an MCP batch or delegated transaction) spends one budget
 * around all of its inner calls, which run under an unbudgeted principal.
 */
export type DeadlineBudget = {
  readonly ms: Readonly<Record<DeadlineClass, number>>;
};

/**
 * Wall-clock budget for one MCP tool call, by declared action budget. A call that dies at
 * the platform (an empty 503 from a Worker resource limit) reaches the MCP
 * client as no JSON-RPC response at all, which the connector proxy reports as
 * a bare "Invalid content from server"; answering first keeps the tool name,
 * request id, and next step in front of the caller.
 *
 * - Reads, 18 s: the motivating read's HTTP twin died with an empty 503 after
 *   ~22 s. Abandoning a read loses nothing, and the caller can narrow it.
 * - Model-backed reads (`modelBacked` on the action), the decision model's 30 s retry budget
 *   plus 15 s for the database work around it: a Retry-After inside the decision model's
 *   budget must not turn into an MCP timeout.
 * - Writes, 230 s: the Postgres work is not cancelled, so an early answer only
 *   turns a likely success into an unknown one. AI-backed imports legitimately
 *   run for minutes: the connector held tool calls open for up to ~208 s that
 *   returned 200, and one at ~240 s ended in a 500.
 *
 * A deadline only fires when the call yields to the event loop; a synchronous
 * CPU loop or an out-of-memory kill still ends the request without an answer.
 */
export const MCP_TOOL_DEADLINE_MS = {
  read: 18_000,
  modelRead: DECISION_DEADLINE_MS + 15_000,
  write: 230_000,
} as const satisfies Record<DeadlineClass, number>;

export type Principal = {
  readonly channel: Channel;
  readonly credential: Credential | "system";
  /** Actor, Ledger Party and request services; the runner selects read policy per call. */
  readonly context: AuthenticatedRequestContext;
  /** Null for a client that does not identify itself. */
  readonly client: ClientBuild | null;
  readonly delegation: RunDelegation | null;
  /** Null: the platform's own request limit is the only deadline. */
  readonly budget: DeadlineBudget | null;
  /** The Better Auth session behind a cookie or bearer credential. */
  readonly session: {
    readonly id: string;
    readonly expiresAt: Date | null;
  } | null;
  /** Session refreshes (`set-auth-token`, session-data cookies) the adapter forwards. */
  readonly responseHeaders: Headers;
};

/** A refusal before any operation runs; the adapter renders it in its protocol. */
export type Challenge = {
  readonly status: 401 | 403;
  readonly code: "UNAUTHORIZED" | "FORBIDDEN";
  readonly message: string;
};

export const isChallenge = (
  result: Principal | Challenge,
): result is Challenge => "status" in result;

/** A challenge as an operation failure, for adapters that answer in an operation envelope. */
export const challengeError = (challenge: Challenge) =>
  new AppError({
    code: challenge.code,
    reason: challenge.code === "FORBIDDEN" ? "FOREIGN_ORIGIN" : "UNAUTHORIZED",
    message: challenge.message,
  });

export interface AuthPorts {
  getSession: HttpSessionReader;
  verifyApiKey(options: {
    body: { key: string; configId: "http-api" };
  }): Promise<{
    valid: boolean;
    key?: { configId?: string | null; referenceId: string } | null;
  }>;
  verifyMcpToken(request: Request): Promise<McpActor | null>;
  context(options: {
    headers: Headers;
    actor: RequestActor;
  }): Promise<AuthenticatedRequestContext>;
  /** The delegation's grant is live and the actor, a member, started its Run. */
  delegationHolds(
    context: AuthenticatedRequestContext,
    delegation: RunDelegation,
  ): Promise<boolean>;
}

export type AuthHooks = {
  /** The credential verified; a later failure may show the caller its cause. */
  onVerified?: () => void;
};

const AUDIT_CHANNEL = {
  browser: "web",
  api: "api",
  mcp: "mcp",
} as const satisfies Record<AuthPolicy["surface"], AuditChannel>;

const CREDENTIAL_NAMES = {
  "api-key": "API key",
  bearer: "bearer token",
  cookie: "session",
  "mcp-token": "OAuth access token",
} as const satisfies Record<Credential, string>;

const unauthorized = (policy: AuthPolicy): Challenge => {
  const names = policy.credentials.map((name) => CREDENTIAL_NAMES[name]);
  const list =
    names.length > 2
      ? `${names.slice(0, -1).join(", ")}, or ${names.at(-1)}`
      : names.join(" or ");
  return {
    status: 401,
    code: "UNAUTHORIZED",
    message: `Valid ${list} required`,
  };
};

const FOREIGN_ORIGIN: Challenge = {
  status: 403,
  code: "FORBIDDEN",
  message: "Same-origin request required",
};

/** Explicit credentials are attached per request; only cookies ride along cross-site. */
const presentedCredential = (
  headers: Headers,
  policy: AuthPolicy,
): Credential => {
  if (headers.has("x-api-key")) return "api-key";
  if (/^bearer\s+\S/iu.test(headers.get("authorization") ?? ""))
    return policy.surface === "mcp" ? "mcp-token" : "bearer";
  return "cookie";
};

/**
 * The one same-origin rule. An ambient cookie is the only credential a
 * foreign page can make a browser send, so a cookie request that can act (any
 * method but a plain GET/HEAD, or a WebSocket upgrade, which CORS does not
 * cover) must come from this origin: a matching `Origin`, or, when a browser
 * omits it, `Sec-Fetch-Site: same-origin`.
 */
function crossSiteCookieRequest(request: Request): boolean {
  const reads =
    (request.method === "GET" || request.method === "HEAD") &&
    request.headers.get("upgrade")?.toLowerCase() !== "websocket";
  if (reads) return false;
  const origin = request.headers.get("origin");
  return origin
    ? origin !== new URL(request.url).origin
    : request.headers.get("sec-fetch-site") !== "same-origin";
}

const clientUserAgent = /^(?<product>[a-z][a-z0-9-]*)\/(?<version>\S+)/u;

function clientBuild(headers: Headers): ClientBuild | null {
  const match = clientUserAgent.exec(headers.get("user-agent") ?? "")?.groups;
  if (!match?.product || !match.version) return null;
  return {
    product: match.product,
    version: match.version,
    updateRequired: appleClientUpdateRequired(headers),
  };
}

const sessionDataCookieName =
  /^(?:__Secure-)?better-auth\.session_data(?:\.\d+)?$/u;

const sessionDataCookiesFrom = (headers: Headers): string[] =>
  headers.getSetCookie().filter((cookie) => {
    const separator = cookie.indexOf("=");
    return (
      separator > 0 &&
      sessionDataCookieName.test(cookie.slice(0, separator).trim())
    );
  });

type Verified = {
  actor: RequestActor;
  session: Principal["session"];
  delegation: RunDelegation | null;
  responseHeaders: Headers;
};

async function verifyCredential(
  ports: AuthPorts,
  request: Request,
  credential: Credential,
  policy: AuthPolicy,
): Promise<Verified | null> {
  const channel = AUDIT_CHANNEL[policy.surface];
  const responseHeaders = new Headers();
  if (credential === "api-key") {
    const key = request.headers.get("x-api-key") ?? "";
    const verification = await ports.verifyApiKey({
      body: { key, configId: "http-api" },
    });
    if (!verification.valid || verification.key?.configId !== "http-api")
      return null;
    return {
      actor: {
        userId: userId.parse(verification.key.referenceId),
        sessionId: null,
        channel,
      },
      session: null,
      delegation: null,
      responseHeaders,
    };
  }
  if (credential === "mcp-token") {
    const actor = await ports.verifyMcpToken(request);
    if (!actor) return null;
    // A run-scoped token without its grant is no delegation the grant check
    // can hold, so it never acts at all.
    if (actor.purchaseAgentRunId && !actor.purchaseAgentGrantId) return null;
    return {
      actor: {
        userId: actor.userId,
        sessionId: actor.sessionId,
        channel,
        oauthClientId: actor.clientId,
        // The agent's token is scoped to its run, so everything it writes
        // inherits that run (validated against the grant before use).
        runId: actor.purchaseAgentRunId
          ? runEntityId.parse(actor.purchaseAgentRunId)
          : null,
      },
      session: null,
      delegation:
        actor.purchaseAgentRunId && actor.purchaseAgentGrantId
          ? {
              runId: actor.purchaseAgentRunId,
              grantId: actor.purchaseAgentGrantId,
              generation: actor.purchaseAgentGeneration,
            }
          : null,
      responseHeaders,
    };
  }
  const result = await authenticateHttpSession({
    headers: request.headers,
    getSession: ports.getSession,
    fresh: policy.freshSession === true,
  });
  const session = result.response;
  if (!session) return null;
  if (credential === "bearer") {
    const token = result.headers.get("set-auth-token");
    if (token) responseHeaders.set("set-auth-token", token);
  }
  for (const cookie of sessionDataCookiesFrom(result.headers))
    responseHeaders.append("Set-Cookie", cookie);
  return {
    actor: {
      userId: userId.parse(session.user.id),
      sessionId: session.session.id,
      channel,
    },
    session: {
      id: session.session.id,
      expiresAt: session.session.expiresAt
        ? new Date(session.session.expiresAt)
        : null,
    },
    delegation: null,
    responseHeaders,
  };
}

export function createAuthenticator(ports: AuthPorts) {
  return async function authenticate(
    request: Request,
    policy: AuthPolicy,
    hooks: AuthHooks = {},
  ): Promise<Principal | Challenge> {
    const credential = presentedCredential(request.headers, policy);
    if (!policy.credentials.includes(credential)) return unauthorized(policy);
    // Without a Cookie header nothing ambient was sent; verification answers
    // 401 instead of the origin rule answering 403.
    if (
      credential === "cookie" &&
      request.headers.has("cookie") &&
      crossSiteCookieRequest(request)
    )
      return FOREIGN_ORIGIN;
    const verified = await withTrace("auth.verify", async (span) => {
      span.setAttribute("cubby.auth.method", credential);
      const result = await verifyCredential(ports, request, credential, policy);
      span.setAttribute("cubby.auth.authenticated", result !== null);
      return result;
    });
    if (!verified) return unauthorized(policy);
    hooks.onVerified?.();
    // Downstream origin-derived work (calendar feed URLs) sees this server's
    // origin; the rule above already refused a cookie request from another.
    const headers = new Headers(request.headers);
    headers.set("origin", new URL(request.url).origin);
    const context = await withTrace("auth.context", () =>
      ports.context({ headers, actor: verified.actor }),
    );
    if (
      verified.delegation &&
      !(await ports.delegationHolds(context, verified.delegation))
    )
      return unauthorized(policy);
    const client = clientBuild(request.headers);
    const channel: Channel =
      policy.surface === "mcp"
        ? "mcp"
        : policy.surface === "browser"
          ? "browser"
          : client?.product.startsWith("cubby-apple")
            ? "native"
            : "cli";
    return {
      channel,
      credential,
      context,
      client,
      delegation: verified.delegation,
      budget: channel === "mcp" ? { ms: MCP_TOOL_DEADLINE_MS } : null,
      session: verified.session,
      responseHeaders: verified.responseHeaders,
    };
  };
}

export type Authenticate = ReturnType<typeof createAuthenticator>;

/** Internal work (workflow commands, tests) acting as an already-resolved actor. */
export function systemPrincipal(
  context: AuthenticatedRequestContext,
  overrides: Partial<Omit<Principal, "context">> = {},
): Principal {
  return {
    channel: "system",
    credential: "system",
    context,
    client: null,
    delegation: null,
    budget: null,
    session: null,
    responseHeaders: new Headers(),
    ...overrides,
  };
}

/** The same principal acting through another request context, e.g. a transaction. */
export const principalWithContext = (
  principal: Principal,
  context: AuthenticatedRequestContext,
): Principal => ({ ...principal, context });

/**
 * A delegated Run must be the actor's own and the actor a member whose party
 * owns it, except a photo Run: it records belongings for either member
 * (`run-service.ts`), so it may be owned by the other member's party.
 * Requiring the actor's party there 401'd every MCP call of such a Run's
 * coordinator (RUN-DFBE2).
 */
export const delegatedRunHolds = (
  scope: {
    actorUserId: string | null;
    ledgerPartyId: string | null;
    public: { purpose: string };
  },
  actorUserId: string,
  party: { id: string } | null | undefined,
) =>
  scope.actorUserId === actorUserId &&
  !!party &&
  (party.id === scope.ledgerPartyId ||
    scope.public.purpose === "photo_inventory");

export const authenticate = createAuthenticator({
  getSession: (options) => getAuth().api.getSession(options),
  verifyApiKey: (options) => getAuth().api.verifyApiKey(options),
  // Lazy: the JWS verifier and the delegation secret serve only `/api/mcp`.
  verifyMcpToken: async (request) =>
    (await import("~/server/mcp/auth")).verifyMcpToken(request),
  context: async (options) => requireActor(await createRequestContext(options)),
  delegationHolds: async (context, delegation) => {
    const [{ findActivePurchaseAgentGrant }, { loadRunScope }] =
      await Promise.all([
        import("~/server/domains/purchase-import/repo/agent-auth"),
        import("~/server/domains/purchase-import/repo/run-service"),
      ]);
    const actorUserId = context.actorContext.userId;
    const grant = await findActivePurchaseAgentGrant(
      context.db,
      actorUserId,
      delegation.grantId,
    );
    if (!grant) return false;
    const [scope, party] = await Promise.all([
      loadRunScope(context.db, delegation.runId),
      context.currentParty(),
    ]);
    return delegatedRunHolds(scope, actorUserId, party);
  },
});
