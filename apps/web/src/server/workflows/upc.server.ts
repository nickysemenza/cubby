import type { upcLookupInput } from "@cubby/upc-contract";
import type { z } from "zod";

import type { AuthenticatedStartOperationContext } from "~/server/start-operation.server";
import { defineWorkflowOperation } from "~/server/workflow-runtime";

export const lookupUpcWorkflow = defineWorkflowOperation(
  "upc.lookup",
  (
    context: Pick<AuthenticatedStartOperationContext, "upcLookupClient">,
    input: z.output<typeof upcLookupInput>,
  ) => context.upcLookupClient.lookup(input.upc),
);
