import { z } from "zod";

import type { StartOperationIdOfKind } from "~/lib/generated/start-operation-registry.gen";
import {
  type StartOperationDefinition,
  startOperationDefinitionFor,
} from "~/lib/start-operation-observability";
import {
  type UnparsedStartOperationData,
  unparsedStartOperationDataSchema,
} from "~/server/start-operation.contract";

type BrowserStartOperationId = StartOperationIdOfKind<"query" | "mutation">;

export type StartOperationDispatchInput<
  Operation extends BrowserStartOperationId = BrowserStartOperationId,
> = {
  operation: Operation;
  input: UnparsedStartOperationData;
};

const isBrowserStartOperationDefinition = (
  definition: StartOperationDefinition | undefined,
): definition is StartOperationDefinition<BrowserStartOperationId> =>
  definition !== undefined && definition.kind !== "subscription";

const startOperationIdSchema = z.string().transform((operation, ctx) => {
  const definition = startOperationDefinitionFor(operation);
  if (isBrowserStartOperationDefinition(definition)) return definition.id;
  ctx.addIssue({
    code: "custom",
    message: `Unknown Start operation: ${operation}`,
  });
  return z.NEVER;
});

export const startOperationDispatchInput = z.object({
  operation: startOperationIdSchema,
  input: unparsedStartOperationDataSchema,
});
