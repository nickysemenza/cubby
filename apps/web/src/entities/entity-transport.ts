import type { PublicImpactItem } from "@cubby/schemas/entity-integrity";
import { getFlag } from "~/lib/flags";

export type PublicEntityError = {
  message: string;
  code?: string;
  reason?: string;
  blockers?: PublicImpactItem[];
};

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

export async function observedEntityCall<T>(
  operation: "entity.list" | "entity.detail" | "entity.filterOptions",
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
