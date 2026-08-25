import { cookbookSummariesOut } from "@cubby/schemas/import-recipe";
import { type CookbookSummary, cookbookSummary } from "@cubby/schemas/recipe";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
import * as cookbookBrowser from "~/server/cookbook-browser.server";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";

const listCookbooksTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .handler(
    async ({ context }) =>
      await cookbookBrowser.listCookbookSummaries({
        request: context.startOperation,
      }),
  );

const getCookbookDetailTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as { shortcode: string })
  .handler(
    async ({ data, context }) =>
      await cookbookBrowser.getCookbookDetail({
        data,
        request: context.startOperation,
      }),
  );

const cookbookListOperation = startOperation<null, CookbookSummary[]>({
  operation: "cookbook.list",
  entity: "cookbook",
  transport: (_input, { signal, headers }) =>
    listCookbooksTransport({ signal, headers }),
  parse: (result) => cookbookSummariesOut.parse(result),
});

const cookbookDetailOperation = startOperation<
  { shortcode: string },
  CookbookSummary | null
>({
  operation: "cookbook.detail",
  entity: "cookbook",
  transport: (data, { signal, headers }) =>
    getCookbookDetailTransport({ data, signal, headers }),
  parse: (result) => cookbookSummary.nullable().parse(result),
});

export const cookbookListQueryOptions = () =>
  queryOptions({
    queryKey: [["cookbook", "list"]] as const,
    meta: cookbookListOperation.meta,
    queryFn: ({ signal }) => cookbookListOperation.call(null, { signal }),
  });

export const cookbookDetailQueryOptions = (shortcode: string) =>
  queryOptions({
    queryKey: [["cookbook", "detail"], { shortcode }] as const,
    meta: cookbookDetailOperation.meta,
    queryFn: ({ signal }) =>
      cookbookDetailOperation.call({ shortcode }, { signal }),
  });
