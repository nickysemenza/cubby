import { testShortcode } from "@cubby/schemas/testing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it } from "vitest";
import { z } from "zod";

import { listReadFields } from "~/entity/model/list-read-schema";
import { entityList } from "~/integrations/tanstack-query/generated/catalog/entityList.gen";

import type { ListQueryPlan } from "./use-paginated-table-core";
import { useServerTreeChildren } from "./use-server-tree-children";

it("hydrates expanded children using advertised fields through the field-validating operation", async () => {
  const root = { id: testShortcode("product", "tree-root") };
  const child = { id: testShortcode("product", "tree-child") };
  const operation = entityList.listEnrichment.withTransport(
    async ({ input }) => {
      const fields = z
        .array(z.enum(listReadFields("product").derived))
        .parse(input.fields);
      expect(fields).toEqual(["unitPrice"]);
      return {
        entity: "product",
        groups: [
          {
            id: "derived",
            fields,
            state: "ready",
            data: [{ ...child, unitPrice: null }],
          },
        ],
        missingIds: [],
      };
    },
  );
  const plan: ListQueryPlan<{ id: string; unitPrice?: null }> = {
    queryKey: ["synthetic-tree-children"],
    execute: async () => ({
      items: [child],
      meta: { pageIndex: 0, pageSize: 25, totalCount: 1 },
      deferredGroups: [{ id: "derived", fields: ["unitPrice"] }],
    }),
    progressive: {
      enrich: (ids, fields, signal) =>
        operation.call({ entity: "product", ids, fields }, { signal }),
      summary: async () => ({}),
    },
  };
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const planFor = () => plan;
  const view = renderHook(
    () => useServerTreeChildren({ enabled: true, scope: "synthetic", planFor }),
    { wrapper },
  );
  try {
    act(() => view.result.current.onExpandedChange({ [root.id]: true }));
    await waitFor(() =>
      expect(view.result.current.attach([root])[0]?.subRows).toEqual([
        { ...child, unitPrice: null },
      ]),
    );
  } finally {
    view.unmount();
    client.clear();
  }
});
