import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";
import {
  type StartOperationDefinition,
  startOperationDefinitionFor,
} from "~/lib/start-operation-observability";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";
import {
  type UnparsedStartOperationData,
  unparsedStartOperationDataSchema,
} from "~/server/start-operation.contract";

type BrowserStartOperationId = StartOperationIdOfKind<"query" | "mutation">;
type BrowserStartOperationDefinition =
  StartOperationDefinition<BrowserStartOperationId>;

const isBrowserStartOperationDefinition = (
  definition: StartOperationDefinition | undefined,
): definition is BrowserStartOperationDefinition =>
  definition !== undefined && definition.kind !== "subscription";

export type StartOperationDispatchInput<
  Operation extends BrowserStartOperationId = BrowserStartOperationId,
> = {
  operation: Operation;
  input: UnparsedStartOperationData;
};

const startOperationIdSchema = z.string().transform((operation, ctx) => {
  const definition = startOperationDefinitionFor(operation);
  if (isBrowserStartOperationDefinition(definition)) return definition.id;
  ctx.addIssue({
    code: "custom",
    message: `Unknown Start operation: ${operation}`,
  });
  return z.NEVER;
});
const startOperationDispatchInput = z.object({
  operation: startOperationIdSchema,
  input: unparsedStartOperationDataSchema,
});

/** The only ordinary browser-to-Worker Start function. */
const dispatchStartOperationServerFunction = createServerFn({
  method: "POST",
})
  .middleware([authenticatedStartServerFunction])
  .validator(<Value>(value: Value) => startOperationDispatchInput.parse(value))
  .handler(async ({ data, context }) => {
    const { dispatchStartOperation } =
      await import("~/server/start-operation-dispatch.server");
    return await dispatchStartOperation({
      operation: data.operation,
      input: data.input,
      request: context.startOperation,
    });
  });

export const dispatchStartOperationTransport =
  dispatchStartOperationServerFunction;
