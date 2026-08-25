import { financialAccountOptionsOut } from "@cubby/schemas/financial-account";
import { financialTransactionSourceOptionsOut } from "@cubby/schemas/financial-transaction";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
import { queryKeys } from "~/lib/query-keys";
import * as browser from "~/server/finance-browser.server";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";

const accountOptionsTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) =>
    browser.financialAccountOptionsForBrowser({
      request: context.startOperation,
    }),
  );
const sourceOptionsTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) =>
    browser.financialTransactionSourceOptionsForBrowser({
      request: context.startOperation,
    }),
  );
const accountOptionsOperation = startOperation<
  null,
  z.output<typeof financialAccountOptionsOut>
>({
  operation: "financialAccount.options",
  transport: (_input, { signal, headers }) =>
    accountOptionsTransport({ signal, headers }),
  parse: (value) => financialAccountOptionsOut.parse(value),
});
const sourceOptionsOperation = startOperation<
  null,
  z.output<typeof financialTransactionSourceOptionsOut>
>({
  operation: "financialTransaction.sourceOptions",
  transport: (_input, { signal, headers }) =>
    sourceOptionsTransport({ signal, headers }),
  parse: (value) => financialTransactionSourceOptionsOut.parse(value),
});

export const financialAccountOptionsQueryOptions = () =>
  queryOptions({
    queryKey: [...queryKeys.financialAccount.all, "options"] as const,
    meta: accountOptionsOperation.meta,
    queryFn: ({ signal }) => accountOptionsOperation.call(null, { signal }),
  });
export const financialTransactionSourceOptionsQueryOptions = () =>
  queryOptions({
    queryKey: [...queryKeys.financialTransaction.all, "sourceOptions"] as const,
    meta: sourceOptionsOperation.meta,
    queryFn: ({ signal }) => sourceOptionsOperation.call(null, { signal }),
  });
