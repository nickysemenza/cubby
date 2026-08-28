import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { StartOperationId } from "~/lib/start-operation-observability";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";
import type { StartOperationResult } from "~/server/start-operation.contract";

export type StartOperationDispatchInput = {
  operation: StartOperationId;
  input: unknown;
};

const startOperationDispatchInput = z.object({
  operation: z.string(),
  input: z.unknown(),
});

/** The only ordinary browser-to-Worker Start function. */
const dispatchStartOperationServerFunction = createServerFn({
  method: "POST",
})
  .middleware([authenticatedStartServerFunction])
  .validator(
    (value: unknown) =>
      startOperationDispatchInput.parse(value) as StartOperationDispatchInput,
  )
  .handler(async ({ data, context }) => {
    const { dispatchStartOperation } =
      await import("~/server/start-operation-dispatch.server");
    return (await dispatchStartOperation({
      operation: data.operation,
      input: data.input,
      request: context.startOperation,
    })) as never;
  });

export const dispatchStartOperationTransport =
  dispatchStartOperationServerFunction as unknown as (options: {
    data: StartOperationDispatchInput;
    signal?: AbortSignal;
    headers?: HeadersInit;
  }) => Promise<StartOperationResult<unknown>>;
