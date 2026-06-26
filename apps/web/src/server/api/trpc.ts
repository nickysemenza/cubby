/**
 * YOU PROBABLY DON'T NEED TO EDIT THIS FILE, UNLESS:
 * 1. You want to modify request context (see Part 1).
 * 2. You want to create a new middleware or type of procedure (see Part 3).
 *
 * TL;DR - This is where all the tRPC server stuff is created and plugged in. The pieces you will
 * need to use are documented accordingly near the end.
 */

import { buildActorContext } from "@cubby/schemas/context";
import { type UserId, unsafeUserId } from "@cubby/schemas/identifiers";
import * as Sentry from "@sentry/tanstackstart-react";
import { initTRPC, type TRPCRouterRecord } from "@trpc/server";
import { flatten } from "flat";
import superjson from "superjson";
import { ZodError } from "zod";
import { env } from "~/env";
import { auth as betterAuth } from "~/lib/auth";
import { getErrorMessage } from "~/lib/error-utils";
import { getBindingFetcher } from "~/server/cf-env";
import { NotionClient } from "~/server/clients/notion";
import { UPCLookupClient } from "~/server/clients/upc-lookup";
import { USDAClient } from "~/server/clients/usda";
import type { Database } from "~/server/db";
import { db } from "~/server/db";
import { createAppError, isExpectedTRPCError } from "~/server/errors/app-error";
import { translateDatabaseError } from "~/server/errors/db-errors";
import { findProductsByFoodIdentifier } from "~/server/repo/product";
import { AvailabilityService } from "~/server/services/availability.service";
import { IngredientService } from "~/server/services/ingredient.service";
import { LocationValuationService } from "~/server/services/location-valuation.service";
import { ProductService } from "~/server/services/product.service";
import { RecipeCostingService } from "~/server/services/recipe-costing.service";
import { USDAService } from "~/server/services/usda.service";
import {
  type AppSpan,
  extractTraceContext,
  TraceNames,
  withTrace,
} from "~/server/tracing";

/**
 * Helper function to build crud services for both production and test contexts.
 * Also reused by the recompute queue consumer (cf-server `queue()`), which needs
 * `services.recipeCosting` without a full tRPC request context.
 */
export const buildCrudServices = (
  db: Database,
  opts?: { usdaFetcher?: typeof fetch },
) => {
  const notionClient = env.NOTION_API_KEY
    ? new NotionClient(env.NOTION_API_KEY)
    : null;
  const usdaClient = new USDAClient(
    env.USDA_API_URL,
    opts?.usdaFetcher ?? getBindingFetcher("USDA_API"),
  );
  const upcLookupClient = new UPCLookupClient(
    env.UPC_LOOKUP_API_URL,
    env.UPC_LOOKUP_API_KEY,
    { fetcher: getBindingFetcher("UPC_LOOKUP") },
  );
  const usdaService = new USDAService(usdaClient, async (lookup) => {
    return await findProductsByFoodIdentifier(db, lookup);
  });
  const ingredient = new IngredientService(db, usdaClient);
  const services = {
    product: new ProductService(db, usdaClient),
    ingredient,
    availability: new AvailabilityService(db, ingredient),
    recipeCosting: new RecipeCostingService(db, ingredient),
    locationValuation: new LocationValuationService(db),
  };

  return {
    db,
    notionClient,
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
  // Extract trace context from headers and set it as active context (dev only —
  // in the CF Worker the platform manages context, so this just runs the body).
  const headersObj: Record<string, string> = {};
  opts.headers.forEach((value, key) => {
    headersObj[key] = value;
  });

  return await extractTraceContext(headersObj, async () => {
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
        message: zodError.issues
          .map((issue) =>
            issue.path.length > 0
              ? `${issue.path.join(".")}: ${issue.message}`
              : issue.message,
          )
          .join(", "),
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

/** Keys whose values must never reach a trace. */
const SENSITIVE_KEY = /pass|token|secret|cookie|authorization/i;
/** Above this serialized size we record the byte count but not the values. */
const INPUT_BYTES_CAP = 4096;

/**
 * Record a tRPC input on the span under `rpc.input.*`, guarded: always emits
 * `rpc.input.bytes`, skips the value dump past {@link INPUT_BYTES_CAP} (setting
 * `rpc.input.truncated`), and redacts secret-ish keys — so traces stay lean and
 * never leak credentials.
 */
const recordInput = (span: AppSpan, input: unknown): void => {
  if (input == null || typeof input !== "object") return;
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return; // non-serializable (e.g. a stream) — skip rather than throw
  }
  span.setAttribute("rpc.input.bytes", serialized.length);
  if (serialized.length > INPUT_BYTES_CAP) {
    span.setAttribute("rpc.input.truncated", true);
    return;
  }
  const flat = flatten({ "rpc.input": input }) as Record<string, unknown>;
  for (const [key, value] of Object.entries(flat)) {
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      continue; // skip null/undefined/nested — primitives only
    }
    span.setAttribute(key, SENSITIVE_KEY.test(key) ? "[redacted]" : value);
  }
};

const tracingMiddleWare = t.middleware(async (opts) =>
  withTrace(TraceNames.trpc(opts.type, opts.path), async (span) => {
    span.setAttributes({
      "rpc.system": "trpc",
      "rpc.method": opts.path,
      "rpc.type": opts.type,
      "enduser.id": opts.ctx.auth?.userId ?? "guest",
    });
    recordInput(span, await opts.getRawInput());
    try {
      const result = await opts.next();

      // tRPC returns errors as results with ok: false, not thrown.
      if (!result.ok) {
        span.setError(getErrorMessage(result.error));
        // Only capture *unexpected* errors to Sentry. Expected 4xx business
        // errors (NOT_FOUND, UNAUTHORIZED, validation, …) are normal responses
        // — they already skip console logging in createAppError, have zero user
        // impact, and would otherwise flood Sentry with thousands of events
        // (e.g. a stale cached getByID for a deleted entity).
        if (!isExpectedTRPCError(result.error)) {
          Sentry.captureException(result.error, {
            extra: { trpcPath: opts.path, trpcType: opts.type },
          });
        }
      }

      return result;
    } catch (error) {
      // Unexpected errors that bypass tRPC error handling. withTrace marks the
      // span errored + records the exception; we add the Sentry capture.
      Sentry.captureException(error, {
        extra: { trpcPath: opts.path, trpcType: opts.type },
      });
      throw error;
    }
  }),
);

/**
 * Translate raw Postgres constraint errors (unique, FK, not-null, check) into
 * clear TRPCErrors for ALL procedures. Runs as the outermost layer so tracing
 * still records the original error to Sentry, while the client receives the
 * friendly message. No-op for non-database errors.
 */
const dbErrorMiddleware = t.middleware(async (opts) => {
  const result = await opts.next();
  if (!result.ok) {
    const translated = translateDatabaseError(result.error);
    if (translated) throw translated;
  }
  return result;
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
  .use(dbErrorMiddleware)
  .use(tracingMiddleWare);

export const protectedProcedure = publicProcedure.use(isAuthed);

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
  // USDA is always-available in prod (CF Worker) and now throws on a real
  // service error rather than degrading to null. Tests have no USDA backend, so
  // stub the fetcher to mimic the worker's "food not found" contract — hermetic,
  // no thrown network error, the same "no USDA data" the suite always assumed:
  //   - the batch endpoint (/api/foods/search/batch) returns 200 with an empty
  //     results array (per-item misses); findFoodsBatch maps every item to null.
  //     It must NOT 404 — findFoodsBatch throws on a non-200 (a real service
  //     error), and product/recipe enrichment runs through the batch path.
  //   - every other lookup (getFood / search / list) 404s → `food: null`.
  const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const crudServices = buildCrudServices(db, {
    usdaFetcher: (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      return url.includes("/search/batch")
        ? jsonResponse(200, { results: [] })
        : jsonResponse(404, null);
    }) as unknown as typeof fetch,
  });
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

/**
 * Test helper: build an authenticated caller for `router` in one call.
 *
 * Collapses the per-test `createCallerFactory(router)(createTestTRPCContext(db,
 * { auth: { userId } }))` boilerplate. Defaults to the standard test actor
 * (same id as tooling/test-setup.ts's TEST_USER_ID); pass `userId` only when a
 * test needs a different actor. The caller's type is fully inferred from
 * `router`, so `caller.create(...)` etc. stay type-checked.
 */
export const createTestCaller = <TRecord extends TRPCRouterRecord>(
  router: Parameters<typeof createCallerFactory<TRecord>>[0],
  db: Database,
  userId: UserId = unsafeUserId("test-user-id"),
): ReturnType<ReturnType<typeof createCallerFactory<TRecord>>> =>
  createCallerFactory<TRecord>(router)(
    createTestTRPCContext(db, { auth: { userId } }),
  );
