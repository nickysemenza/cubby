import { buildActorContext } from "@cubby/schemas/context";
import { type UserId, unsafeUserId } from "@cubby/schemas/identifiers";
import { initTRPC, TRPCError, type TRPCRouterRecord } from "@trpc/server";
import superjson from "superjson";
import { ZodError, type ZodType, type z } from "zod";
import type { Database } from "~/server/db";
import {
  appErrorFromUnknown,
  createAppError,
  toPublicErrorPayload,
} from "~/server/errors/app-error";
import { translateDatabaseError } from "~/server/errors/db-errors";
import { observeRequest } from "~/server/observed-request";
import {
  buildCrudServices,
  createRequestContext,
} from "~/server/request-context";
import type { RequestOrigin } from "~/server/workload";
import { classifyTrpcWorkload } from "~/server/workload";

export const createTRPCContext = createRequestContext;

const t = initTRPC.context<typeof createTRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    if (error.cause instanceof ZodError) {
      const zodError = error.cause;

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

    // `cause` itself never crosses the wire, so anything a client needs has to
    // be lifted onto `shape.data` explicitly. That lift is `toPublicErrorPayload`
    // — the SAME function the MCP error path calls, because two hand-written
    // whitelists drifted apart once already and dropped `blockers` on the MCP
    // side. `code` is not read from it here: `shape.data.code` already carries
    // it on this transport.
    const { reason, blockers } = toPublicErrorPayload(error);

    return {
      ...shape,
      data: {
        ...shape.data,
        zodError: null,
        reason,
        ...(blockers ? { blockers } : {}),
      },
    };
  },
});

export const createCallerFactory = t.createCallerFactory;

export const createTRPCRouter = t.router;

const tracingMiddleWare = t.middleware(async (opts) => {
  const input = await opts.getRawInput();
  return await observeRequest({
    system: "trpc",
    method: opts.path,
    type: opts.type,
    origin: opts.ctx.requestOrigin,
    actorId: opts.ctx.auth?.userId,
    input,
    workload: classifyTrpcWorkload(opts.ctx.requestOrigin, opts.path),
    includeInputValues:
      opts.ctx.requestOrigin !== "mcp" && opts.ctx.requestOrigin !== "agent",
    run: opts.next,
    inspectResult: (result) =>
      result.ok
        ? {
            workload: classifyTrpcWorkload(
              opts.ctx.requestOrigin,
              opts.path,
              result.data,
            ),
          }
        : { error: result.error },
  });
});

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

/** Convert the neutral application error at the tRPC seam. */
const appErrorMiddleware = t.middleware(async (opts) => {
  const result = await opts.next();
  if (!result.ok) {
    const appError = appErrorFromUnknown(result.error);
    if (appError) {
      throw new TRPCError({
        code: appError.code,
        message: appError.message,
        cause: appError,
      });
    }
  }
  return result;
});

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
      requestOrigin: ctx.requestOrigin,
    },
  });
});

const publicProcedure = t.procedure
  .use(dbErrorMiddleware)
  .use(tracingMiddleWare)
  .use(appErrorMiddleware);

export const protectedProcedure = publicProcedure.use(isAuthed);

/**
 * Make tRPC type-check a resolver against a Zod output's PARSED type.
 *
 * tRPC normally checks a resolver against `z.input<TSchema>`, because output
 * parsers may transform a resolver's raw value. That is too permissive for our
 * public entity schemas: shortcode brands exist only in `z.output<TSchema>`,
 * while `z.input<TSchema>` is a plain string and therefore also accepts a
 * branded UUID such as `ProductId`. Runtime parsing still catches the wrong
 * prefix, but only after the request has run.
 *
 * Use this on explicit router `.output(...)` declarations. It is a type-only
 * narrowing; the original schema object and runtime parsing are unchanged.
 */
export const strictOutput = <TSchema extends ZodType>(schema: TSchema) =>
  schema as ZodType<z.output<TSchema>, z.output<TSchema>>;

const createTestAuth = (userId: UserId) => ({
  userId,
  sessionId: "test-session-id",
});

export const createTestTRPCContext = (
  db: Database,
  opts: {
    headers?: Headers;
    auth?: { userId: UserId };
    readDb?: Database;
  } = {},
) => {
  // Batch misses are 200s; single-food misses are 404s. A batch 404 represents
  // a service failure and would make enrichment throw.
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

  const actorContext = auth.userId
    ? buildActorContext(auth.userId, "ui")
    : null;

  return {
    ...crudServices,
    readDb: opts.readDb ?? db,
    readConsistency: {
      consistency: "strong" as const,
      reason: "single-database" as const,
    },
    auth,
    isSystemRequest: false, // Test contexts are not system requests by default
    actorContext,
    requestOrigin: "ui" as RequestOrigin,
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
