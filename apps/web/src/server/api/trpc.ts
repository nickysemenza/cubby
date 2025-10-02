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
import { type Span, context, propagation } from "@opentelemetry/api";
import { getTracer, TraceNames } from "~/server/tracing";
import { auth } from "@clerk/nextjs/server";
import { USDAClient } from "~/server/clients/usda";
import { ProductService } from "~/server/services/product.service";
import { IngredientService } from "~/server/services/ingredient.service";
import { USDAService } from "~/server/services/usda.service";
import { findProductsByFoodIdentifier } from "~/server/repo/product";
import { type Database } from "~/server/db";
import { env } from "~/env";
import { ProjectService } from "~/server/services/project.service";
import {
  projectId as projectIdSchema,
  type ProjectId,
  unsafeProjectId,
} from "~/schemas/identifiers";

/**
 * Helper function to build crud services for both production and test contexts
 */
const buildCrudServices = (db: Database) => {
  const usdaClient = new USDAClient(env.USDA_API_URL);
  const usdaService = new USDAService(usdaClient, (lookup) =>
    findProductsByFoodIdentifier(db, lookup),
  );
  const services = {
    product: new ProductService(db, usdaClient),
    ingredient: new IngredientService(db, usdaClient),
  };

  return {
    db,
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
  // Extract trace context from headers and set it as active context
  const headersObj: Record<string, string> = {};
  opts.headers.forEach((value, key) => {
    headersObj[key] = value;
  });
  const parentContext = propagation.extract(context.active(), headersObj);

  return await context.with(parentContext, async () => {
    const crudServices = buildCrudServices(db);
    const authResult = opts.headers.has("skip-auth") ? undefined : await auth();

    let projectId: ProjectId;
    let isSystemRequest = false;

    // Check for system API key
    const systemKey = opts.headers.get("x-system-key");
    const expectedSystemKey = process.env.SYSTEM_API_KEY;
    if (systemKey && expectedSystemKey && systemKey === expectedSystemKey) {
      isSystemRequest = true;
      // For system requests, projectId is required
      const requestedProjectId = opts.headers.get("x-project-id");
      if (!requestedProjectId) {
        throw new Error("x-project-id header is required for system requests");
      }
      projectId = projectIdSchema.parse(requestedProjectId);
    } else if (authResult?.userId) {
      const projectService = new ProjectService(db);

      // Get projectId from header (sent by client from localStorage)
      let requestedProjectId = opts.headers.get("x-project-id") || undefined;

      // Verify access if projectId provided
      if (requestedProjectId) {
        const hasAccess = await projectService.verifyProjectAccess(
          authResult.userId,
          requestedProjectId,
        );
        if (!hasAccess) {
          requestedProjectId = undefined;
        }
      }

      // If no valid project, get default (this always returns a branded ProjectId)
      if (!requestedProjectId) {
        projectId = projectIdSchema.parse(
          await projectService.ensureDefaultProject(authResult.userId),
        );
      } else {
        projectId = projectIdSchema.parse(requestedProjectId);
      }
    } else {
      // For unauthenticated users, we'll provide a placeholder
      // but protected procedures will catch this and require auth
      projectId = "unauthenticated" as ProjectId;
    }

    return {
      ...crudServices,
      auth: authResult,
      projectId,
      isSystemRequest,
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
 * System procedure for operations that can be authenticated with system API key
 * Used for scripts and system-level operations
 */
const isSystemOrAuth = t.middleware(({ next, ctx }) => {
  if (!ctx.auth?.userId && !ctx.isSystemRequest) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx,
  });
});

export const systemProcedure = publicProcedure.use(isSystemOrAuth);

/**
 * Helper to create a minimal auth object for testing
 */
const createTestAuth = (userId: string): Awaited<ReturnType<typeof auth>> => {
  return {
    userId,
    sessionClaims: {},
    sessionId: "test-session-id",
    sessionStatus: "active" as const,
    actor: null,
    orgId: null,
    orgRole: null,
    orgSlug: null,
    orgPermissions: null,
    getToken: async () => null,
    has: () => false,
    debug: () => null,
    redirectToSignIn: () => {
      throw new Error("redirectToSignIn not implemented in test");
    },
    redirectToSignUp: () => {
      throw new Error("redirectToSignUp not implemented in test");
    },
  } as unknown as Awaited<ReturnType<typeof auth>>;
};

/**
 * Test helper to create a TRPC context for testing purposes
 */
export const createTestTRPCContext = (
  db: Database,
  opts: {
    headers?: Headers;
    auth?: { userId: string };
    projectId?: ProjectId;
  } = {},
) => {
  const crudServices = buildCrudServices(db);

  return {
    ...crudServices,
    auth: opts.auth ? createTestAuth(opts.auth.userId) : undefined,
    projectId:
      opts.projectId ?? unsafeProjectId("00000000-0000-0000-0000-000000000000"),
    isSystemRequest: false, // Test contexts are not system requests by default
    headers: opts.headers ?? new Headers(),
  };
};
