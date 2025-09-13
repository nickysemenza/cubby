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
import { type Span, trace } from "@opentelemetry/api";
import { auth } from "@clerk/nextjs/server";
import { USDAClient } from "~/server/clients/usda";
import { ProductService } from "~/server/services/product.service";
import { IngredientService } from "~/server/services/ingredient.service";
import { USDAService } from "~/server/services/usda.service";
import { findProductsByFoodIdentifier } from "~/server/repo/product";
import { type PrismaClient } from "@prisma/client";
import { UsdaApiClient } from "~/usda-api-client/usda-api";
import { env } from "~/env";

/**
 * Helper function to build crud services for both production and test contexts
 */
const buildCrudServices = (database: PrismaClient) => {
  const usdaApiClient = new UsdaApiClient(env.USDA_API_URL);
  const usdaClient = new USDAClient(usdaApiClient);
  const usdaService = new USDAService(usdaClient, (lookup) =>
    findProductsByFoodIdentifier(database, lookup),
  );
  const services = {
    product: new ProductService(database, usdaClient),
    ingredient: new IngredientService(database, usdaClient),
  };

  return {
    db: database,
    usdaClient,
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
  const crudServices = buildCrudServices(db);

  return {
    ...crudServices,
    auth: opts.headers.has("skip-auth") ? undefined : await auth(),
    ...opts,
  };
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

    return {
      ...shape,
      data: {
        ...shape.data,
        zodError: null,
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
  console.log(`[TRPC] ${path} took ${end - start}ms to execute`);

  return result;
});

const tracingMiddleWare = t.middleware(async (opts) => {
  const tracer = trace.getTracer("trpc");
  return tracer.startActiveSpan(
    `TRPC ${opts.type}: ${opts.path}`,
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
// cf https://clerk.com/docs/references/nextjs/trpc#create-a-protected-procedure
const isAuthed = t.middleware(({ next, ctx }) => {
  if (!ctx.auth?.userId) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: {
      auth: ctx.auth,
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
 * Test helper to create a TRPC context for testing purposes
 */
export const createTestTRPCContext = (
  db: PrismaClient,
  opts: { headers?: Headers; auth?: undefined } = {},
) => {
  const crudServices = buildCrudServices(db);

  return {
    ...crudServices,
    auth: opts.auth,
    headers: opts.headers ?? new Headers(),
  };
};
