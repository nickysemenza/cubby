import {
  type linkExpensesToPurchaseInput,
  type mergePurchasesInput,
  mergePurchasesOut,
  purchaseOut,
  type purchaseProductMutationInput,
  purchaseProductMutationOut,
  type purchaseProductsInput,
  purchaseProductsOut,
  type splitExpenseInput,
  splitExpenseOut,
} from "@cubby/schemas/purchase";
import { mutationOptions, queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import type { CubbyOperationMeta } from "~/integrations/tanstack-query/operation-meta";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
import { markFreshReads } from "~/lib/fresh-read-marker";
import { queryKeys } from "~/lib/query-keys";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";
import * as browser from "~/server/purchase-browser.server";

const productsTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof purchaseProductsInput>)
  .handler(({ data, context }) =>
    browser.purchaseProductsForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const linkTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof linkExpensesToPurchaseInput>,
  )
  .handler(({ data, context }) =>
    browser.linkPurchaseForBrowser({ data, request: context.startOperation }),
  );
const splitTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof splitExpenseInput>)
  .handler(({ data, context }) =>
    browser.splitPurchaseForBrowser({ data, request: context.startOperation }),
  );
const mergeTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof mergePurchasesInput>)
  .handler(({ data, context }) =>
    browser.mergePurchaseForBrowser({ data, request: context.startOperation }),
  );
const attachProductsTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof purchaseProductMutationInput>,
  )
  .handler(({ data, context }) =>
    browser.attachPurchaseProductsForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const detachProductsTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof purchaseProductMutationInput>,
  )
  .handler(({ data, context }) =>
    browser.detachPurchaseProductsForBrowser({
      data,
      request: context.startOperation,
    }),
  );

const productsOperation = startOperation<
  z.input<typeof purchaseProductsInput>,
  z.output<typeof purchaseProductsOut>
>({
  operation: "purchase.products",
  transport: (data, { signal, headers }) =>
    productsTransport({ data, signal, headers }),
  parse: (value) => purchaseProductsOut.parse(value),
});
const linkOperation = startOperation<
  z.input<typeof linkExpensesToPurchaseInput>,
  z.output<typeof purchaseOut>
>({
  operation: "purchase.link",
  kind: "mutation",
  transport: (data, { headers }) => linkTransport({ data, headers }),
  parse: (value) => purchaseOut.parse(value),
});
const splitOperation = startOperation<
  z.input<typeof splitExpenseInput>,
  z.output<typeof splitExpenseOut>
>({
  operation: "purchase.split",
  kind: "mutation",
  transport: (data, { headers }) => splitTransport({ data, headers }),
  parse: (value) => splitExpenseOut.parse(value),
});
const mergeOperation = startOperation<
  z.input<typeof mergePurchasesInput>,
  z.output<typeof mergePurchasesOut>
>({
  operation: "purchase.merge",
  kind: "mutation",
  transport: (data, { headers }) => mergeTransport({ data, headers }),
  parse: (value) => mergePurchasesOut.parse(value),
});
const attachProductsOperation = startOperation<
  z.input<typeof purchaseProductMutationInput>,
  z.output<typeof purchaseProductMutationOut>
>({
  operation: "purchase.attachProducts",
  kind: "mutation",
  transport: (data, { headers }) => attachProductsTransport({ data, headers }),
  parse: (value) => purchaseProductMutationOut.parse(value),
});
const detachProductsOperation = startOperation<
  z.input<typeof purchaseProductMutationInput>,
  z.output<typeof purchaseProductMutationOut>
>({
  operation: "purchase.detachProducts",
  kind: "mutation",
  transport: (data, { headers }) => detachProductsTransport({ data, headers }),
  parse: (value) => purchaseProductMutationOut.parse(value),
});

export const purchaseProductsQueryOptions = (
  input: z.input<typeof purchaseProductsInput>,
) =>
  queryOptions({
    queryKey: [...queryKeys.purchase.all, "products", { input }] as const,
    meta: productsOperation.meta,
    queryFn: ({ signal }) => productsOperation.call(input, { signal }),
  });

const mutation =
  <I, O>(
    key: string,
    operation: { meta: CubbyOperationMeta; call: (input: I) => Promise<O> },
  ) =>
  () =>
    mutationOptions({
      mutationKey: [...queryKeys.purchase.all, key] as const,
      meta: operation.meta,
      mutationFn: async (input: I) => {
        const result = await operation.call(input);
        markFreshReads();
        return result;
      },
    });

export const linkPurchaseMutationOptions = mutation("link", linkOperation);
export const splitPurchaseMutationOptions = mutation("split", splitOperation);
export const mergePurchaseMutationOptions = mutation("merge", mergeOperation);
export const attachPurchaseProductsMutationOptions = mutation(
  "attachProducts",
  attachProductsOperation,
);
export const detachPurchaseProductsMutationOptions = mutation(
  "detachProducts",
  detachProductsOperation,
);
