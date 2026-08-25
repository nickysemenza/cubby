import type { PublicImpactItem } from "@cubby/schemas/entity-integrity";
import { getFlag } from "~/lib/flags";

export type PublicEntityError = {
  message: string;
  code?: string;
  reason?: string;
  blockers?: PublicImpactItem[];
};

export type EntityTransportOperation =
  | "entity.list"
  | "entity.detail"
  | "entity.filterOptions"
  | "entity.mutate";

export type EntityTransportResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: PublicEntityError };

export class EntityTransportError extends Error {
  readonly data: Omit<PublicEntityError, "message">;

  constructor(error: PublicEntityError) {
    super(error.message);
    this.name = "EntityTransportError";
    this.data = {
      ...(error.code ? { code: error.code } : {}),
      ...(error.reason ? { reason: error.reason } : {}),
      ...(error.blockers ? { blockers: error.blockers } : {}),
    };
  }
}

let requestId = 0;

export function unwrapEntityTransportResult<T>(
  operation: EntityTransportOperation,
  result: EntityTransportResult<T>,
  createError: (error: PublicEntityError) => Error = (error) =>
    new EntityTransportError(error),
): T {
  if (!result.ok) throw createError(result.error);
  if (result.data === undefined) {
    throw createError({
      code: "INTERNAL_SERVER_ERROR",
      reason: "INVALID_TRANSPORT_RESULT",
      message: `${operation} returned an empty success envelope`,
    });
  }
  return result.data;
}

export async function observedEntityCall<T>(
  operation: EntityTransportOperation,
  input: unknown,
  call: () => Promise<T>,
): Promise<T> {
  const isBrowser = typeof window !== "undefined";
  const shouldLog = isBrowser && getFlag("queryLogger");
  const id = shouldLog ? ++requestId : 0;
  const startedAt = performance.now();
  if (shouldLog) console.log(`>> ${id} ${operation}`, { input });
  try {
    const result = await call();
    if (shouldLog) {
      console.log(`<< ${id} ${operation}`, {
        result,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
    }
    return result;
  } catch (error) {
    if (isBrowser && (shouldLog || error instanceof Error)) {
      console.error(`<< ${id || "error"} ${operation}`, error);
    }
    throw error;
  }
}
