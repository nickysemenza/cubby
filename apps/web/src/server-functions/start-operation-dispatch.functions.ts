import { createServerFn } from "@tanstack/react-start";

import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";
import { startOperationDispatchInput } from "~/server/start-operation-dispatch.contract";

/** The only ordinary browser-to-Worker Start function. */
const dispatchStartOperationServerFunction = createServerFn({
  method: "POST",
})
  .middleware([authenticatedStartServerFunction])
  .validator(<Value>(value: Value) => value)
  .handler(async ({ data, context }) => {
    const { dispatchStartOperation } =
      await import("~/server/start-operation-dispatch.server");
    const { normalizeStartOperationError } =
      await import("~/server/start-operation.server");
    const { getRequestId } = await import("~/server/tracing");
    try {
      const parsed = startOperationDispatchInput.parse(data);
      return await dispatchStartOperation({
        ...parsed,
        request: context.startOperation,
      });
    } catch (error) {
      if (context.startOperation.signal.aborted) throw error;
      return {
        ok: false as const,
        error: normalizeStartOperationError(
          error,
          "input",
          getRequestId(context.startOperation.headers),
          {
            operation: "dispatch",
            authenticated: false,
            headers: context.startOperation.headers,
          },
        ).publicError,
      };
    }
  });

export const dispatchStartOperationTransport =
  dispatchStartOperationServerFunction;
