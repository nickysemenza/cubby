import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EntityEditResult } from "~/entities/editing/types";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { useCubbyTable } from "../data-table/table-features";
import type { DeletableConfig } from "./useDeletableConfig";
import { useOptimisticDelete } from "./useOptimisticDelete";

interface TestRow {
  id: string;
  name: string | null;
}

const deletedProduct = (id: string) =>
  ({
    ok: true,
    entity: "product",
    id,
    changed: true,
  }) satisfies EntityEditResult<"product">;

const refusedProduct = {
  ok: false,
  issues: [{ message: "Delete refused", source: "server" }],
} satisfies EntityEditResult<"product">;

function registeredDeletable(): DeletableConfig {
  return {
    mutationOptions: () => ({
      mutationFn: async ({ ids }) => ({ deleted: ids.length }),
    }),
    entityLabel: "Product",
    entity: "product",
  };
}

function imageDeletable(requests: string[][]): DeletableConfig {
  return {
    mutationOptions: () => ({
      mutationFn: async ({ ids }) => {
        requests.push([...ids]);
        return { deleted: ids.length };
      },
    }),
    entityLabel: "Image",
    entity: "image",
  };
}

function useTableRows(rows: TestRow[]) {
  return useCubbyTable({
    data: rows,
    columns: [],
    getRowId: (row) => row.id,
  }).getRowModel().rows;
}

function createDeferredCommandPort() {
  const requests: string[][] = [];
  let resolvePending:
    | ((result: EntityEditResult<"product">) => void)
    | undefined;
  return {
    requests,
    commandPort: {
      remove: (ids: readonly string[]) => {
        requests.push([...ids]);
        return new Promise<EntityEditResult<"product">>((resolve) => {
          resolvePending = resolve;
        });
      },
    },
    resolve(result: EntityEditResult<"product">) {
      if (!resolvePending) throw new Error("Delete command has not started.");
      resolvePending(result);
    },
  };
}

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function QueryHarness({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={harness.queryClient}>
      {children}
    </QueryClientProvider>
  );
}

describe("useOptimisticDelete", () => {
  it("optimistically removes paginated rows, then restores the snapshot on a registered refusal", async () => {
    const command = createDeferredCommandPort();
    const key = [["product"], { page: "all" }] as const;
    const original = {
      pages: [
        {
          items: [
            { id: "PRD-2222", name: "Apples" },
            { id: "PRD-3333", name: "Bananas" },
          ],
          count: 2,
          meta: { totalCount: 2, cursor: "next" },
        },
      ],
      pageParams: [0],
    };
    harness.queryClient.setQueryDefaults(key, {
      meta: { cacheTags: [["product"]] },
    });
    harness.queryClient.setQueryData(key, original);
    const hook = renderHook(
      () =>
        useOptimisticDelete<TestRow>({
          deletable: registeredDeletable(),
          commandPort: command.commandPort,
        }),
      { wrapper: QueryHarness },
    );

    act(() => {
      hook.result.current.requestDelete({ id: "PRD-2222", name: "Apples" });
    });
    render(<>{hook.result.current.deleteDialog}</>, { wrapper: QueryHarness });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(harness.queryClient.getQueryData(key)).toEqual({
        pages: [
          {
            items: [{ id: "PRD-3333", name: "Bananas" }],
            count: 1,
            meta: { totalCount: 1, cursor: "next" },
          },
        ],
        pageParams: [0],
      }),
    );

    command.resolve(refusedProduct);
    await waitFor(() =>
      expect(harness.queryClient.getQueryData(key)).toEqual(original),
    );
  });

  it("opens one real confirmation dialog for every selected row and preserves selection on cancel", async () => {
    const command = createDeferredCommandPort();
    const rows = [
      { id: "PRD-2222", name: "Apples" },
      { id: "PRD-3333", name: "Bananas" },
    ];
    const hook = renderHook(
      () =>
        useOptimisticDelete<TestRow>({
          deletable: registeredDeletable(),
          commandPort: command.commandPort,
        }),
      { wrapper: QueryHarness },
    );
    const table = renderHook(() => useTableRows(rows), {
      wrapper: QueryHarness,
    });
    const action = hook.result.current.deleteBulkAction;
    if (!action) throw new Error("Expected delete bulk action");

    let outcome: Promise<{ success: boolean }> | undefined;
    act(() => {
      outcome = action.onExecute(table.result.current);
    });
    if (!outcome) throw new Error("Expected bulk delete outcome.");
    render(<>{hook.result.current.deleteDialog}</>, { wrapper: QueryHarness });

    expect(await screen.findByText("Apples")).toBeVisible();
    expect(screen.getByText("Bananas")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await expect(outcome).resolves.toEqual({ success: false });
    expect(command.requests).toEqual([]);
  });

  it("settles a successful registered bulk delete only after the command finishes", async () => {
    const command = createDeferredCommandPort();
    const rows = [
      { id: "PRD-2222", name: "Apples" },
      { id: "PRD-3333", name: "Bananas" },
    ];
    const hook = renderHook(
      () =>
        useOptimisticDelete<TestRow>({
          deletable: registeredDeletable(),
          commandPort: command.commandPort,
        }),
      { wrapper: QueryHarness },
    );
    const table = renderHook(() => useTableRows(rows), {
      wrapper: QueryHarness,
    });
    const action = hook.result.current.deleteBulkAction;
    if (!action) throw new Error("Expected delete bulk action");

    let outcome: Promise<{ success: boolean }> | undefined;
    act(() => {
      outcome = action.onExecute(table.result.current);
    });
    if (!outcome) throw new Error("Expected bulk delete outcome.");
    render(<>{hook.result.current.deleteDialog}</>, { wrapper: QueryHarness });
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(command.requests).toEqual([["PRD-2222", "PRD-3333"]]),
    );
    command.resolve(deletedProduct("PRD-2222"));

    await expect(outcome).resolves.toEqual({ success: true });
  });

  it("uses the legacy image mutation path without routing through entity commands", async () => {
    const command = createDeferredCommandPort();
    const imageRequests: string[][] = [];
    const hook = renderHook(
      () =>
        useOptimisticDelete<TestRow>({
          deletable: imageDeletable(imageRequests),
          commandPort: command.commandPort,
        }),
      { wrapper: QueryHarness },
    );

    act(() => {
      hook.result.current.requestDelete({ id: "IMG-2222", name: "Receipt" });
    });
    render(<>{hook.result.current.deleteDialog}</>, { wrapper: QueryHarness });
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(imageRequests).toEqual([["IMG-2222"]]));
    expect(command.requests).toEqual([]);
  });
});
