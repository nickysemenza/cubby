import { z } from "zod";

import {
  type PublicOperationError,
  publicOperationErrorSchema,
} from "~/lib/operation-result";
import { toPublicErrorPayload } from "~/server/errors/app-error";
import { errorReportingHeaders } from "~/server/errors/report-error";
import { getRequestId } from "~/server/observability/tracing";
import {
  normalizeOperationError,
  type OperationFailureContext,
  type OperationStage,
} from "~/server/operation-runtime/operation.server";

/**
 * A failure the runner already normalized, reported and described. It is
 * thrown to roll back a delegated transaction or to fail one batch item, and
 * rendered as is: normalizing it again would replace its raw cause.
 */
export class SettledToolFailure extends Error {
  constructor(readonly detail: PublicOperationError) {
    super(detail.message);
    this.name = "SettledToolFailure";
  }
}

export const toolErrorDetailSchema = publicOperationErrorSchema.partial({
  code: true,
});
export type ToolErrorDetail = z.infer<typeof toolErrorDetailSchema>;

export function describeToolError<T>(
  error: T,
  context?: OperationFailureContext,
  stage: OperationStage = "run",
): ToolErrorDetail {
  if (error instanceof SettledToolFailure) {
    const detail: ToolErrorDetail = structuredClone(error.detail);
    if (context?.batchIndex !== undefined && detail.diagnostics)
      detail.diagnostics.batchIndex = context.batchIndex;
    return detail;
  }
  if (context) {
    const headers = context.headers ?? errorReportingHeaders();
    const detail = normalizeOperationError(
      error,
      stage,
      getRequestId(headers),
      {
        ...context,
        headers,
      },
    ).publicError;
    const payload = toPublicErrorPayload(error);
    if (payload.code) {
      detail.code = payload.code;
      detail.reason = payload.reason;
      if (payload.blockers && context.authenticated)
        detail.blockers = payload.blockers;
    }
    return detail;
  }
  const { code, reason } = toPublicErrorPayload(error);
  const message = error instanceof Error ? error.message : String(error);
  const detail: ToolErrorDetail = { message };
  if (code) detail.code = code;
  if (reason) detail.reason = reason;
  return detail;
}
