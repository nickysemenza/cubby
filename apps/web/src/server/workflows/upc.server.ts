import type { upcLookupInput } from "@cubby/upc-contract";
import type { z } from "zod";

import type { AuthenticatedStartOperationContext } from "~/server/start-operation.server";
export const lookupUpcWorkflow = (
  context: Pick<AuthenticatedStartOperationContext, "upcLookupClient">,
  input: z.output<typeof upcLookupInput>,
) => context.upcLookupClient.lookup(input.upc);
