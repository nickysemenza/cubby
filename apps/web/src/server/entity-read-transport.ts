import type { PublicImpactItem } from "@cubby/schemas/entity-integrity";
import { z } from "zod";
import { toPublicErrorPayload } from "~/server/errors/app-error";
import { translateDatabaseError } from "~/server/errors/db-errors";
import { observeRequest } from "~/server/observed-request";
import { createRequestContext, requireActor } from "~/server/request-context";

type PublicEntityTransportError = {
  message: string;
  code?: string;
  reason?: string;
  blockers?: PublicImpactItem[];
};

type EntityReadTransportResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: PublicEntityTransportError };

function publicFailure(
  error: unknown,
): EntityReadTransportResult<never> | null {
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

type AuthenticatedContext = ReturnType<typeof requireActor>;

/** @lintignore Dynamically imported by the client-safe Start transports. */
export async function runEntityReadTransport<T>(options: {
  operation: "entity.list" | "entity.detail" | "entity.filterOptions";
  input: unknown;
  headers: Headers;
  execute: (context: AuthenticatedContext) => Promise<T>;
}): Promise<EntityReadTransportResult<T>> {
  return await observeRequest({
    system: "start",
    method: options.operation,
    type: "query",
    origin: "ui",
    input: options.input,
    workload: "ui",
    run: async (span) => {
      try {
        const context = requireActor(
          await createRequestContext({ headers: options.headers }),
        );
        span.setAttributes({
          "enduser.id": context.auth.userId,
          "cubby.request_origin": context.requestOrigin,
        });
        return { ok: true, data: await options.execute(context) } as const;
      } catch (error) {
        const failure = publicFailure(error);
        if (failure) return failure;
        throw error;
      }
    },
    inspectResult: (result) =>
      result.ok ? {} : { error: result.error, workload: "ui" },
  });
}
