import type {
  FilterOptionsInput,
  FilterOptionsOut,
} from "@cubby/schemas/filter-options";
import type { SearchableEntity } from "@cubby/schemas/search";
import * as drizzle from "drizzle-orm";
import { z } from "zod";
import type { EntityInspectorHealth } from "~/entities/entity-inspector-health.functions";
import type { PublicEntityError } from "~/entities/entity-transport";
import type {
  EntityDetailByEntity,
  EntityDetailInputByEntity,
} from "~/entities/generated/entity-details.gen";
import {
  parseEntityDetailInput,
  parseEntityDetailResult,
} from "~/entities/generated/entity-details.gen";
import type {
  EntityListInputByEntity,
  EntityListResultByEntity,
  ListEntity,
} from "~/entities/generated/entity-lists.gen";
import { parseEntityListResult } from "~/entities/generated/entity-lists.gen";
import { executeEntity } from "~/server/entity-kernel";
import {
  type EntityBrowserMutationCommand,
  type EntityBrowserMutationResult,
  entityBrowserMutationCommandSchema,
  entityBrowserMutationResultSchema,
} from "~/server/entity-kernel/contracts";
import { toPublicErrorPayload } from "~/server/errors/app-error";
import { translateDatabaseError } from "~/server/errors/db-errors";
import { observeRequest } from "~/server/observed-request";
import { getEntityCounts } from "~/server/repo/dashboard";
import { getFilterOptions } from "~/server/repo/filter-options";
import { executeSearchDocumentSql } from "~/server/repo/search-document";
import { createRequestContext, requireActor } from "~/server/request-context";

/**
 * The only server-only implementation behind the generic Start functions.
 * Keeping context assembly, error translation, and kernel execution here makes
 * the `*.functions.ts` modules safe browser contracts rather than isomorphic
 * server adapters.
 */

export type EntityRuntimeContext = ReturnType<typeof requireActor>;

export type EntityRuntimeRequest = {
  context: EntityRuntimeContext;
  signal: AbortSignal;
  operationId?: string;
};

export type EntityTransportResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: PublicEntityError };

export async function authenticatedEntityRuntimeContext(options: {
  headers: Headers;
  signal: AbortSignal;
}): Promise<EntityRuntimeRequest> {
  throwIfAborted(options.signal);
  return {
    context: requireActor(
      await createRequestContext({ headers: options.headers }),
    ),
    signal: options.signal,
    operationId: options.headers.get("x-cubby-operation-id") ?? undefined,
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The entity operation was cancelled", "AbortError");
}

function publicFailure(error: unknown): EntityTransportResult<never> | null {
  if (error instanceof z.ZodError) {
    return {
      ok: false,
      error: {
        code: "BAD_REQUEST",
        reason: "INVALID_INPUT",
        message: error.issues.map((issue) => issue.message).join(", "),
      },
    };
  }
  const translated = translateDatabaseError(error) ?? error;
  const payload = toPublicErrorPayload(translated);
  if (!payload.code && !payload.reason && !payload.blockers) return null;
  return {
    ok: false,
    error: {
      message:
        translated instanceof Error ? translated.message : String(translated),
      ...payload,
    },
  };
}

type ReadOperation = "entity.list" | "entity.detail" | "entity.filterOptions";

async function runRead<T>(options: {
  operation: ReadOperation;
  input: unknown;
  request: EntityRuntimeRequest;
  execute: (context: EntityRuntimeContext) => Promise<T>;
}): Promise<EntityTransportResult<T>> {
  return await observeRequest({
    system: "start",
    method: options.operation,
    type: "query",
    origin: "ui",
    input: options.input,
    workload: "ui",
    operationId: options.request.operationId,
    run: async (span) => {
      try {
        throwIfAborted(options.request.signal);
        const context = options.request.context;
        span.setAttributes({
          "enduser.id": context.auth.userId,
          "cubby.request_origin": context.requestOrigin,
          "cubby.read.consistency":
            options.operation === "entity.detail"
              ? "strong"
              : context.readConsistency.consistency,
          "cubby.read.reason":
            options.operation === "entity.detail"
              ? "authoritative-operation"
              : context.readConsistency.reason,
        });
        const data = await options.execute(context);
        // Database calls do not presently accept AbortSignal. This checkpoint
        // truthfully prevents an already-cancelled request from publishing a
        // completed result while preserving the existing DB consistency policy.
        throwIfAborted(options.request.signal);
        return { ok: true, data } as const;
      } catch (error) {
        if (options.request.signal.aborted) throw error;
        const failure = publicFailure(error);
        if (failure) return failure;
        throw error;
      }
    },
    inspectResult: (result) =>
      result.ok ? {} : { error: result.error, workload: "ui" },
  });
}

export async function getEntityList<E extends ListEntity>(options: {
  data: EntityListInputByEntity[E];
  request: EntityRuntimeRequest;
}): Promise<EntityTransportResult<EntityListResultByEntity[E]>> {
  return await runRead({
    operation: "entity.list",
    input: options.data,
    request: options.request,
    execute: async (context) => {
      const result = await executeEntity(context, {
        action: "list",
        ...options.data,
      });
      if (result.action !== "list") {
        throw new Error("Entity kernel returned the wrong action");
      }
      return parseEntityListResult(options.data.entity, {
        items: result.items,
        meta: result.meta,
      });
    },
  });
}

export async function getEntityDetail(options: {
  data: EntityDetailInputByEntity[keyof EntityDetailByEntity];
  request: EntityRuntimeRequest;
}): Promise<
  EntityTransportResult<EntityDetailByEntity[keyof EntityDetailByEntity] | null>
> {
  return await runRead({
    operation: "entity.detail",
    input: options.data,
    request: options.request,
    execute: async (context) => {
      const input = parseEntityDetailInput(options.data.entity, options.data);
      const result = await executeEntity(context, {
        action: "get",
        entity: input.entity,
        id: input.shortcode,
        missing: "null",
      });
      if (result.action !== "get") {
        throw new Error("Entity kernel returned the wrong action");
      }
      return result.item === null
        ? null
        : parseEntityDetailResult(input.entity, result.item);
    },
  });
}

export async function getEntityFilterOptions(options: {
  data: FilterOptionsInput;
  request: EntityRuntimeRequest;
}): Promise<EntityTransportResult<FilterOptionsOut>> {
  return await runRead({
    operation: "entity.filterOptions",
    input: options.data,
    request: options.request,
    execute: async (context) =>
      await getFilterOptions(context.readDb, options.data),
  });
}

export async function executeEntityMutation(options: {
  data: EntityBrowserMutationCommand;
  request: EntityRuntimeRequest;
}): Promise<EntityTransportResult<EntityBrowserMutationResult>> {
  return await observeRequest({
    system: "start",
    method: "entity.mutate",
    type: "mutation",
    origin: "ui",
    input: options.data,
    workload: "ui",
    operationId: options.request.operationId,
    run: async (span) => {
      try {
        throwIfAborted(options.request.signal);
        const command = entityBrowserMutationCommandSchema.parse(options.data);
        const context = options.request.context;
        span.setAttributes({
          "enduser.id": context.auth.userId,
          "cubby.request_origin": context.requestOrigin,
          "cubby.read.consistency": "strong",
          "cubby.read.reason": "mutation",
        });
        const data = entityBrowserMutationResultSchema.parse(
          await executeEntity(context, command),
        );
        throwIfAborted(options.request.signal);
        return { ok: true, data } as const;
      } catch (error) {
        if (options.request.signal.aborted) throw error;
        const failure = publicFailure(error);
        if (failure) return failure;
        throw error;
      }
    },
    inspectResult: (result) =>
      result.ok ? {} : { error: result.error, workload: "ui" },
  });
}

export async function getEntityInspectorHealth(options: {
  request: EntityRuntimeRequest;
}): Promise<EntityInspectorHealth> {
  throwIfAborted(options.request.signal);
  const [counts, rows] = await Promise.all([
    getEntityCounts(options.request.context.db),
    executeSearchDocumentSql<{
      entityType: SearchableEntity;
      documents: number;
      embeddings: number;
    }>(
      options.request.context.db,
      drizzle.sql`
        SELECT
          sd."entityType" AS "entityType",
          count(DISTINCT sd."entityId")::int AS documents,
          count(DISTINCT ee."entityId")::int AS embeddings
        FROM "SearchDocument" sd
        LEFT JOIN "EntityEmbedding" ee
          ON ee."entityType" = sd."entityType"
          AND ee."entityId" = sd."entityId"
          AND ee."deletedAt" IS NULL
        WHERE sd."deletedAt" IS NULL
        GROUP BY sd."entityType"
      `,
    ),
  ]);
  throwIfAborted(options.request.signal);
  return {
    counts,
    search: Object.fromEntries(
      rows.map((row) => [
        row.entityType,
        { documents: row.documents, embeddings: row.embeddings },
      ]),
    ),
  };
}
