import { cookbookSummariesOut } from "@cubby/schemas/import-recipe";
import { cookbookSummary } from "@cubby/schemas/recipe";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import {
  observedStartCall,
  unwrapStartOperationResult,
} from "~/integrations/tanstack-query/start-transport";
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

export const cookbookListQueryOptions = () =>
  queryOptions({
    queryKey: [["cookbook", "list"]] as const,
    queryFn: ({ signal }) =>
      observedStartCall({
        operation: "cookbook.list",
        entity: "cookbook",
        input: undefined,
        call: async (headers) =>
          cookbookSummariesOut.parse(
            unwrapStartOperationResult(
              "cookbook.list",
              await listCookbooksTransport({ signal, headers }),
            ),
          ),
      }),
    meta: {
      transport: "start",
      operation: "cookbook.list",
      entity: "cookbook",
      observedByTransport: true,
    },
  });

export const cookbookDetailQueryOptions = (shortcode: string) =>
  queryOptions({
    queryKey: [["cookbook", "detail"], { shortcode }] as const,
    queryFn: ({ signal }) =>
      observedStartCall({
        operation: "cookbook.detail",
        entity: "cookbook",
        input: { shortcode },
        call: async (headers) =>
          cookbookSummary.nullable().parse(
            unwrapStartOperationResult(
              "cookbook.detail",
              await getCookbookDetailTransport({
                data: { shortcode },
                signal,
                headers,
              }),
            ),
          ),
      }),
    meta: {
      transport: "start",
      operation: "cookbook.detail",
      entity: "cookbook",
      observedByTransport: true,
    },
  });
