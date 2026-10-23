import { type StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";
import { withErrorReporting } from "~/server/errors/report-error";
import {
  START_OPERATION_HANDLER_LOADERS,
  type LoadedStartOperationHandler,
  type StartOperationDispatchResult,
} from "~/server/generated/start-operation-handlers.gen";
import { getRequestId, withTrace } from "~/server/observability/tracing";
import type { StartOperationDispatchInput } from "~/server/operation-runtime/start-operation-dispatch.contract";
import {
  type StartOperationRequest,
  normalizeStartOperationError,
} from "~/server/operation-runtime/start-operation.server";

type BrowserStartOperationId = StartOperationIdOfKind<"query" | "mutation">;
export type StartOperationHandlerLoaders = Partial<{
  [Operation in BrowserStartOperationId]: () => Promise<
    LoadedStartOperationHandler<Operation>
  >;
}>;

/**
 * The one entry from every adapter (browser, native HTTP, MCP) to a query or
 * mutation: load its handler by id and run it through `runStartOperation`
 * under the principal the adapter authenticated.
 */
export async function dispatchStartOperation(
  options: StartOperationDispatchInput & { request: StartOperationRequest },
  loaders: StartOperationHandlerLoaders = START_OPERATION_HANDLER_LOADERS,
): Promise<StartOperationDispatchResult<BrowserStartOperationId>> {
  return withErrorReporting(async () => {
    try {
      const loader = loaders[options.operation];
      if (!loader)
        throw new Error(
          `No browser handler is registered for ${options.operation}`,
        );
      const handler = await withTrace<
        LoadedStartOperationHandler<BrowserStartOperationId>
      >(`start.dispatch.load.${options.operation}`, () => loader());
      return await handler({ data: options.input, request: options.request });
    } catch (error) {
      if (options.request.signal.aborted) throw error;
      return {
        ok: false,
        error: normalizeStartOperationError(
          error,
          "dispatch",
          getRequestId(options.request.headers),
          {
            operation: options.operation,
            authenticated: true,
            headers: options.request.headers,
          },
        ).publicError,
      };
    }
  });
}
