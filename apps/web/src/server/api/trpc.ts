/**
 * YOU PROBABLY DON'T NEED TO EDIT THIS FILE, UNLESS:
 * 1. You want to modify request context (see Part 1).
 * 2. You want to create a new middleware or type of procedure (see Part 3).
 *
 * TL;DR - This is where all the tRPC server stuff is created and plugged in. The pieces you will
 * need to use are documented accordingly near the end.
 */

import {
  context,
  propagation,
  type Span,
  SpanStatusCode,
} from "@opentelemetry/api";
import * as Sentry from "@sentry/tanstackstart-react";
import { initTRPC } from "@trpc/server";
import { flatten } from "flat";
import superjson from "superjson";
import { ZodError } from "zod";
import { env } from "~/env";

import { auth as betterAuth } from "~/lib/auth";
import { getErrorMessage } from "~/lib/error-utils";
import { buildActorContext } from "~/schemas/context";
import {
  type UserId,
  unsafeProductId,
  unsafeUserId,
} from "~/schemas/identifiers";
import { UPCLookupClient } from "~/server/clients/upc-lookup";
import { USDAClient } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import { db } from "~/server/db";
// Import and re-export createAppError from dedicated module to avoid circular dependencies
import { createAppError } from "~/server/errors/app-error";
import { findProductsByFoodIdentifier } from "~/server/repo/product";
import { IngredientService } from "~/server/services/ingredient.service";
import { ProductService } from "~/server/services/product.service";
import { USDAService } from "~/server/services/usda.service";
import { getTracer, TraceNames } from "~/server/tracing";
export { createAppError };

/**
 * Map database product record to ProductTopLevelOut format
 * Excludes DB-only fields (deletedAt, ingredientId)
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

    const userId = betterSession?.user?.id
      ? unsafeUserId(betterSession.user.id)
      : null;
    const actorContext = userId ? buildActorContext(userId, "ui") : null;

    return {
      ...crudServices,
      auth: {
        userId,
        sessionId: betterSession?.session?.id ?? null,
      },
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
      try {
        const result = await opts.next();
        span.setAttributes({ ok: result.ok });

        // tRPC returns errors as results with ok: false, not thrown
        if (!result.ok) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: getErrorMessage(result.error),
          });
          // Capture tRPC errors to Sentry
          Sentry.captureException(result.error, {
            extra: {
              trpcPath: opts.path,
              trpcType: opts.type,
            },
          });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }

        return result;
      } catch (error) {
        // Unexpected errors that bypass tRPC error handling
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: getErrorMessage(error),
        });
        Sentry.captureException(error, {
          extra: {
            trpcPath: opts.path,
            trpcType: opts.type,
          },
        });
        throw error;
      } finally {
        span.end();
      }
    },
  );
});

// Check if the user is signed in and has actorContext
// Otherwise, throw an UNAUTHORIZED code
const isAuthed = t.middleware(({ next, ctx }) => {
  if (!ctx.auth?.userId) {
    throw createAppError("UNAUTHORIZED", "Unauthorized");
  }
  if (!ctx.actorContext) {
    throw createAppError(
      "UNAUTHORIZED",
      "Actor context required for this operation",
    );
  }
  return next({
    ctx: {
      auth: ctx.auth,
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

export const protectedProcedure = publicProcedure.use(isAuthed);

/**
 * System procedure for operations that can be authenticated with API key
 * Used for scripts and system-level operations
 * API keys automatically create sessions via better-auth plugin
 */
export const systemProcedure = publicProcedure.use(isAuthed);

/**
 * Helper to create a minimal auth object for testing
 */
const createTestAuth = (userId: UserId) => ({
  userId,
  sessionId: "test-session-id",
});

/**
 * Test helper to create a TRPC context for testing purposes
 */
export const createTestTRPCContext = (
  db: Database,
  opts: {
    headers?: Headers;
    auth?: { userId: UserId };
  } = {},
) => {
  const crudServices = buildCrudServices(db);
  const auth = opts.auth
    ? createTestAuth(opts.auth.userId)
    : { userId: null, sessionId: null };

  // Build actorContext if we have auth
  const actorContext = auth.userId
    ? buildActorContext(auth.userId, "ui")
    : null;

  return {
    ...crudServices,
    auth,
    isSystemRequest: false, // Test contexts are not system requests by default
    actorContext,
    headers: opts.headers ?? new Headers(),
  };
};
