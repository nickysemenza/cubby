/**
 * YOU PROBABLY DON'T NEED TO EDIT THIS FILE, UNLESS:
 * 1. You want to modify request context (see Part 1).
 * 2. You want to create a new middleware or type of procedure (see Part 3).
 *
 * TL;DR - This is where all the tRPC server stuff is created and plugged in. The pieces you will
 * need to use are documented accordingly near the end.
 */
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";

import { db } from "~/server/db";
import { flatten } from "flat";
import {
  type Span,
  SpanStatusCode,
  context,
  propagation,
  trace,
} from "@opentelemetry/api";
import { getTracer, TraceNames } from "~/server/tracing";
import { auth as betterAuth } from "~/lib/auth";
import { USDAClient } from "~/server/clients/usda";
import { UPCLookupClient } from "~/server/clients/upc-lookup";
import { ProductService } from "~/server/services/product.service";
import { IngredientService } from "~/server/services/ingredient.service";
import { USDAService } from "~/server/services/usda.service";
import { findProductsByFoodIdentifier } from "~/server/repo/product";
import type { Database } from "~/server/db";
import { env } from "~/env";
import {
  unsafeProductId,
  unsafeOrganizationId,
  unsafeUserId,
  type OrganizationId,
  type UserId,
} from "~/schemas/identifiers";
import { AppErrors, type AppErrorReason } from "~/lib/app-error-codes";
import { buildActorContext } from "~/schemas/context";

// Expected 4xx errors that shouldn't be logged as failures
const EXPECTED_ERROR_CODES: Set<string> = new Set([
  "NOT_FOUND",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "BAD_REQUEST",
  "CONFLICT",
  "PRECONDITION_FAILED",
]);

/**
 * Create a TRPCError with consistent error handling:
 * - Derives tRPC error code from AppErrorReason
 * - Logs unexpected errors to console (skips expected 4xx responses)
 * - Annotates the active tracing span with error details
 * - Records the original exception if provided
 */
export function createAppError(
  reason: AppErrorReason,
  message: string,
  originalError?: unknown,
): TRPCError {
  const code = AppErrors[reason];
  const isExpectedError = EXPECTED_ERROR_CODES.has(code);

  // Only log unexpected errors (5xx, etc.) - expected 4xx are normal business responses
  if (!isExpectedError) {
    if (originalError) {
      console.error(`[${reason}] ${message}`, originalError);
    } else {
      console.error(`[${reason}] ${message}`);
    }
  }

  // Annotate tracing span (but don't mark expected errors as ERROR status)
  const span = trace.getActiveSpan();
  if (span) {
    span.setAttributes({
      "error.reason": reason,
      "error.message": message,
    });
    if (!isExpectedError) {
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      if (originalError instanceof Error || typeof originalError === "string") {
        span.recordException(originalError);
      }
    }
  }

  return new TRPCError({
    code,
    message,
    cause: { reason, originalError },
  });
}

/**
 * Map database product record to ProductTopLevelOut format
 * Excludes DB-only fields (deletedAt, organizationId, ingredientId)
 */
const mapProductToTopLevelOut = (
  dbProduct: Awaited<ReturnType<typeof findProductsByFoodIdentifier>>[number],
) => {
  const { ingredientId: _ingredientId, id, ...rest } = dbProduct;
  return {
    ...rest,
    id: unsafeProductId(id),
  };
};

/**
 * Helper function to build crud services for both production and test contexts
 */
const buildCrudServices = (db: Database) => {
  const usdaClient = new USDAClient(env.USDA_API_URL);
  const upcLookupClient = new UPCLookupClient(
    env.UPC_LOOKUP_API_URL,
    env.UPC_LOOKUP_API_KEY,
  );
  const usdaService = new USDAService(usdaClient, async (lookup) => {
    const products = await findProductsByFoodIdentifier(db, lookup);
    return products.map(mapProductToTopLevelOut);
  });
  const services = {
    product: new ProductService(db, usdaClient),
    ingredient: new IngredientService(db, usdaClient),
  };

  return {
    db,
    usdaClient,
    upcLookupClient,
    usdaService,
    services,
  };
};

/**
 * 1. CONTEXT
 *
 * This section defines the "contexts" that are available in the backend API.
 *
 * These allow you to access things when processing a request, like the database, the session, etc.
 *
 * This helper generates the "internals" for a tRPC context. The API handler and RSC clients each
 * wrap this and provides the required context.
 *
 * @see https://trpc.io/docs/server/context
 */

export const createTRPCContext = async (opts: { headers: Headers }) => {
  // Extract trace context from headers and set it as active context
  const headersObj: Record<string, string> = {};
  opts.headers.forEach((value, key) => {
    headersObj[key] = value;
  });
  const parentContext = propagation.extract(context.active(), headersObj);

  return await context.with(parentContext, async () => {
    const crudServices = buildCrudServices(db);
    const betterSession = await betterAuth.api.getSession({
      headers: opts.headers,
    });

    // Determine organization ID from header or session
    let organizationId: OrganizationId | null = null;

    // Check for organization ID or slug in header (for API key usage)
    const orgIdOrSlug = opts.headers.get("x-organization-id");
    if (orgIdOrSlug && betterSession?.user?.id) {
      // Fetch user's organizations to validate membership
      const userOrganizations = await betterAuth.api.listOrganizations({
        headers: opts.headers,
      });

      if (!userOrganizations) {
        throw createAppError(
          "ORGANIZATION_FETCH_FAILED",
          "Unable to fetch organization membership",
        );
      }

      // Try to find organization by ID or slug
      const matchedOrg = userOrganizations.find(
        (org) => org.id === orgIdOrSlug || org.slug === orgIdOrSlug,
      );

      if (!matchedOrg) {
        throw createAppError(
          "NOT_ORGANIZATION_MEMBER",
          `You are not a member of organization '${orgIdOrSlug}'`,
        );
      }

      organizationId = unsafeOrganizationId(matchedOrg.id);
    } else {
      // Fall back to active organization from session
      organizationId = betterSession?.session?.activeOrganizationId
        ? unsafeOrganizationId(betterSession.session.activeOrganizationId)
        : null;
    }

    // Build actor context if we have both user and org
    const userId = betterSession?.user?.id
      ? unsafeUserId(betterSession.user.id)
      : null;
    const actorContext =
      userId && organizationId
        ? buildActorContext(userId, organizationId, "ui")
        : null;

    return {
      ...crudServices,
      auth: {
        userId,
        sessionId: betterSession?.session?.id ?? null,
      },
      organizationId,
      actorContext,
      ...opts,
    };
  });
};

/**
 * 2. INITIALIZATION
 *
 * This is where the tRPC API is initialized, connecting the context and transformer. We also parse
 * ZodErrors so that you get typesafety on the frontend if your procedure fails due to validation
 * errors on the backend.
 */
const t = initTRPC.context<typeof createTRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    // If the error was caused by a Zod validation, add the full error details
    if (error.cause instanceof ZodError) {
      const zodError = error.cause;

      // Log the detailed error for server-side debugging
      console.error("[TRPC ZodError]", {
        path: shape.data?.path,
        fullError: zodError.format(),
        issues: zodError.issues,
      });

      return {
        ...shape,
        message: `${shape.message}: ${zodError.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join(", ")}`,
        data: {
          ...shape.data,
          zodError: zodError.flatten(),
          zodIssues: zodError.issues,
        },
      };
    }

    // Pull a structured reason out of error.cause if present
    let reason: string | undefined;
    const cause = (error as { cause?: unknown }).cause;
    if (cause && typeof cause === "object") {
      const r = (cause as Record<string, unknown>).reason;
      if (typeof r === "string") reason = r;
    }

    return {
      ...shape,
      data: {
        ...shape.data,
        zodError: null,
        reason,
      },
    };
  },
});

/**
 * Create a server-side caller.
 *
 * @see https://trpc.io/docs/server/server-side-calls
 */
export const createCallerFactory = t.createCallerFactory;

/**
 * 3. ROUTER & PROCEDURE (THE IMPORTANT BIT)
 *
 * These are the pieces you use to build your tRPC API. You should import these a lot in the
 * "/src/server/api/routers" directory.
 */

/**
 * This is how you create new routers and sub-routers in your tRPC API.
 *
 * @see https://trpc.io/docs/router
 */
export const createTRPCRouter = t.router;

/**
 * Middleware for timing procedure execution and adding an artificial delay in development.
 *
 * You can remove this if you don't like it, but it can help catch unwanted waterfalls by simulating
 * network latency that would occur in production but not in local development.
 */
const timingMiddleware = t.middleware(async ({ next, path }) => {
  const start = Date.now();
  // if (t._config.isDev) {
  //   // artificial delay in dev
  //   const waitMs = Math.floor(Math.random() * 400) + 100;
  //   await new Promise((resolve) => setTimeout(resolve, waitMs));
  // }

  const result = await next();

  const end = Date.now();
  if (process.env.NODE_ENV === "development") {
    console.log(`[TRPC] ${path} took ${end - start}ms to execute`);
  }

  return result;
});

const tracingMiddleWare = t.middleware(async (opts) => {
  const tracer = getTracer();
  return tracer.startActiveSpan(
    TraceNames.trpc(opts.type, opts.path),
    async (span: Span) => {
      const input = await opts.getRawInput();
      if (true && typeof input === "object") {
        span.setAttributes(flatten({ input }));
      }
      span.setAttribute("userId", opts.ctx.auth?.userId ?? "guest");
      span.setAttributes({ path: opts.path });
      const result = await opts.next();
      span.setAttributes({ ok: result.ok });
      return result;
    },
  );
});

// Check if the user is signed in
// Otherwise, throw an UNAUTHORIZED code
const isAuthed = t.middleware(({ next, ctx }) => {
  if (!ctx.auth?.userId) {
    throw createAppError("UNAUTHORIZED", "Unauthorized");
  }
  return next({
    ctx: {
      auth: ctx.auth,
    },
  });
});

// Check if an organization is selected and actorContext is present
// Otherwise, throw a PRECONDITION_FAILED code
const requireOrganization = t.middleware(({ next, ctx }) => {
  if (!ctx.organizationId) {
    throw createAppError(
      "NO_ORGANIZATION_SELECTED",
      "Please select an organization to continue",
    );
  }
  if (!ctx.actorContext) {
    throw createAppError(
      "UNAUTHORIZED",
      "Actor context required for this operation",
    );
  }
  // Narrow the context type to guarantee organizationId and actorContext are non-null
  return next({
    ctx: {
      ...ctx,
      organizationId: ctx.organizationId,
      actorContext: ctx.actorContext,
    },
  });
});

/**
 * Public (unauthenticated) procedure
 *
 * This is the base piece you use to build new queries and mutations on your tRPC API. It does not
 * guarantee that a user querying is authorized, but you can still access user session data if they
 * are logged in.
 */
export const publicProcedure = t.procedure
  .use(timingMiddleware)
  .use(tracingMiddleWare);

export const protectedProcedure = publicProcedure
  .use(isAuthed)
  .use(requireOrganization);

/**
 * System procedure for operations that can be authenticated with API key
 * Used for scripts and system-level operations
 * API keys automatically create sessions via better-auth plugin
 */
const isSystemOrAuth = t.middleware(({ next, ctx }) => {
  if (!ctx.auth?.userId) {
    throw createAppError("UNAUTHORIZED", "Unauthorized");
  }
  return next({
    ctx,
  });
});

export const systemProcedure = publicProcedure
  .use(isSystemOrAuth)
  .use(requireOrganization);

/**
 * Helper to create a minimal auth object for testing
 */
const createTestAuth = (userId: UserId) => ({
  userId,
  sessionId: "test-session-id",
});

/**
 * Test helper to create a TRPC context for testing purposes
 * @lintignore exported for testing
 */
export const createTestTRPCContext = (
  db: Database,
  opts: {
    headers?: Headers;
    auth?: { userId: UserId };
    organizationId?: OrganizationId;
  } = {},
) => {
  const crudServices = buildCrudServices(db);
  const auth = opts.auth
    ? createTestAuth(opts.auth.userId)
    : { userId: null, sessionId: null };
  const organizationId = opts.organizationId ?? null;

  // Build actorContext if we have both auth and organizationId
  const actorContext =
    auth.userId && organizationId
      ? buildActorContext(auth.userId, organizationId, "ui")
      : null;

  return {
    ...crudServices,
    auth,
    isSystemRequest: false, // Test contexts are not system requests by default
    organizationId,
    actorContext,
    headers: opts.headers ?? new Headers(),
  };
};
