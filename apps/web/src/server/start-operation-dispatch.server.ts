import { type StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";
import type { StartOperationDispatchInput } from "~/server-functions/start-operation-dispatch.functions";
import { withErrorReporting } from "~/server/errors/report-error";
import {
  START_OPERATION_HANDLER_LOADERS,
  type LoadedStartOperationHandler,
  type StartOperationDispatchResult,
} from "~/server/generated/start-operation-handlers.gen";
import {
  type StartOperationRequest,
  type OperationStage,
  authenticateStartOperation,
  normalizeStartOperationError,
} from "~/server/start-operation.server";
import { getRequestId, withTrace } from "~/server/tracing";

type BrowserStartOperationId = StartOperationIdOfKind<"query" | "mutation">;
type StartOperationHandlerLoaders = Partial<{
  [Operation in BrowserStartOperationId]: () => Promise<
    LoadedStartOperationHandler<Operation>
  >;
}>;

export async function dispatchStartOperation(
  options: StartOperationDispatchInput & { request: StartOperationRequest },
  loaders: StartOperationHandlerLoaders = START_OPERATION_HANDLER_LOADERS,
): Promise<StartOperationDispatchResult<BrowserStartOperationId>> {
  return withErrorReporting(async () => {
    let stage: OperationStage = "context";
    let actorVerified = Boolean(
      options.request.apiContext ?? options.request.verifiedContext,
    );
    try {
      const verifiedContext =
        options.request.apiContext ??
        options.request.verifiedContext ??
        (await withTrace("start.dispatch.authenticate", (span) =>
          authenticateStartOperation(options.request.headers, span),
        ));
      actorVerified = true;
      stage = "dispatch";
      const loader = loaders[options.operation];
      if (!loader)
        throw new Error(
          `No browser handler is registered for ${options.operation}`,
        );
      const handler = await loader();
      return await handler({
        data: options.input,
        request: { ...options.request, verifiedContext },
      });
    } catch (error) {
      if (options.request.signal.aborted) throw error;
      return {
        ok: false,
        error: normalizeStartOperationError(
          error,
          stage,
          getRequestId(options.request.headers),
          {
            operation: options.operation,
            authenticated: actorVerified,
            headers: options.request.headers,
          },
        ).publicError,
      };
    }
  });
}
