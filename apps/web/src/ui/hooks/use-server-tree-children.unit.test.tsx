import { testShortcode } from "@cubby/schemas/testing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it } from "vitest";

import type { ListQueryPlan } from "./use-paginated-table-core";
import { useServerTreeChildren } from "./use-server-tree-children";

it("loads complete expanded children in one request", async () => {
  const root = { id: testShortcode("product", "tree-root") };
  const child = { id: testShortcode("product", "tree-child") };
  const plan: ListQueryPlan<{ id: string; unitPrice?: null }> = {
    queryKey: ["synthetic-tree-children"],
    execute: async () => ({
      items: [{ ...child, unitPrice: null }],
      meta: { pageIndex: 0, pageSize: 25, totalCount: 1 },
    }),
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
