import {
  productLookupResponseSchema,
  type upcLookupInput,
} from "@cubby/upc-contract";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";
import { lookupUpcForBrowser } from "~/server/upc-browser.server";

const lookupTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((value: unknown) => value as z.input<typeof upcLookupInput>)
  .handler(({ data, context }) =>
    lookupUpcForBrowser({ data, request: context.startOperation }),
  );

const lookupOperation = startOperation({
  operation: "upc.lookup",
  transport: (data: z.input<typeof upcLookupInput>, { signal, headers }) =>
    lookupTransport({ data, signal, headers }),
  parse: (result) => productLookupResponseSchema.nullable().parse(result),
});

export const lookupUpc = (upc: string, signal?: AbortSignal) =>
  lookupOperation.call({ upc }, { signal });
