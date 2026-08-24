import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CubbyRow as Row } from "../data-table/table-features";

/**
 * Pins the fix for the two-tier bug: bulk delete (toolbar) and single-row
 * delete (row menu / swipe) are now literally the same flow over a list of
 * targets — one dialog — instead of bulk delete skipping straight to a
 * delete and routing through `BulkActionBar`'s generic "are you sure" dialog.
 *
 * There is no impact-preview gate any more (see `useOptimisticDelete`'s doc
 * comment): a delete mutation's own structured refusal is the contract, so
 * these no longer mock `entityIntegrity.previewOperation` or assert a
 * `blocked` dialog prop.
 *
 * These treat the memoized `deleteDialog` element as data: reading its props
 * directly is more robust than rendering the underlying base-ui portal dialog
 * in jsdom, and it's a faithful check of what this hook is actually
 * responsible for — wiring the right ids into the shared dialog, not the
 * dialog's own rendering (that's `BulkActionDialog`'s job, already covered
 * elsewhere).
 */

const mocks = vi.hoisted(() => ({
  commandMutation: vi.fn(),
}));

vi.mock("~/integrations/trpc/react", () => ({
  useTRPC: () => ({
    product: {
      delete: {
        mutationOptions: () => ({ mutationFn: mocks.commandMutation }),
      },
    },
  }),
}));

import { useOptimisticDelete } from "./useOptimisticDelete";

interface TestRow {
  id: string;
  name: string | null;
}

/**
 * `BulkAction.onExecute` is typed over `Row<TData>[]` — the full tanstack-table
 * row object — even though this hook's implementation only ever reads
 * `.original`. A real `Row` is expensive to construct in a unit test, so this
 * stands in for one; it's only exercised through `.original` on the receiving
 * end.
 */
function row(original: TestRow): Row<TestRow> {
  return { original } as unknown as Row<TestRow>;
}

function makeDeletable(
  mutationFn: (vars: { ids: string[] }) => Promise<unknown>,
) {
  return {
    mutationOptions: ({
      onSuccess,
      onError,
    }: {
      onSuccess: () => void;
      onError: (err: { message?: string }) => void;
    }) => ({
      mutationFn,
      onSuccess,
      onError,
    }),
    entityLabel: "Product",
    invalidateKeys: [],
    entity: "product" as const,
  };
}

const clients: QueryClient[] = [];
function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  mocks.commandMutation.mockReset();
});

// biome-ignore lint/suspicious/noExplicitAny: reading props off a memoized dialog element for assertions
type AnyDialogElement = ReactElement<any>;

describe("useOptimisticDelete", () => {
  it("opens the whole bulk selection in one dialog, not just the first row", () => {
    const mutationFn = vi.fn().mockResolvedValue({});

    const { result } = renderHook(
      () =>
        useOptimisticDelete<TestRow>({
          deletable: makeDeletable(mutationFn),
        }),
      { wrapper: createWrapper() },
    );

    act(() => {
      void result.current.deleteBulkAction?.onExecute([
        row({ id: "PRD-2222", name: "Apples" }),
        row({ id: "PRD-3333", name: "Bananas" }),
      ]);
    });

    const dialog = result.current.deleteDialog as AnyDialogElement;
    expect(dialog.props.items).toEqual([
      { id: "PRD-2222", name: "Apples" },
      { id: "PRD-3333", name: "Bananas" },
    ]);
  });

  it("resolves the bulk action's held-open promise as unsuccessful on cancel, without deleting", async () => {
    const mutationFn = vi.fn().mockResolvedValue({});
    const { result } = renderHook(
      () =>
        useOptimisticDelete<TestRow>({
          deletable: makeDeletable(mutationFn),
        }),
      { wrapper: createWrapper() },
    );

    let bulkResult: { success: boolean } | undefined;
    act(() => {
      void result.current.deleteBulkAction
        ?.onExecute([row({ id: "PRD-2222", name: "Apples" })])
        .then((r) => {
          bulkResult = r;
        });
    });

    const dialog = result.current.deleteDialog as AnyDialogElement;
    await act(async () => {
      dialog.props.onOpenChange(false);
    });

    await waitFor(() => expect(bulkResult).toEqual({ success: false }));
    expect(mutationFn).not.toHaveBeenCalled();
  });

  it("resolves the bulk action's held-open promise as successful after a real delete", async () => {
    // This is what lets `useBulkActions.executeAction` clear the toolbar's
    // row selection once the delete actually happens — not when the dialog
    // merely opens.
    const mutationFn = vi.fn().mockResolvedValue({});
    mocks.commandMutation.mockResolvedValue({});
    const { result } = renderHook(
      () =>
        useOptimisticDelete<TestRow>({
          deletable: makeDeletable(mutationFn),
        }),
      { wrapper: createWrapper() },
    );

    let bulkResult: { success: boolean } | undefined;
    act(() => {
      void result.current.deleteBulkAction
        ?.onExecute([
          row({ id: "PRD-2222", name: "Apples" }),
          row({ id: "PRD-3333", name: "Bananas" }),
        ])
        .then((r) => {
          bulkResult = r;
        });
    });

    const dialog = result.current.deleteDialog as AnyDialogElement;
    await act(async () => {
      await dialog.props.onSubmit();
    });

    expect(mocks.commandMutation).toHaveBeenCalledWith({
      ids: ["PRD-2222", "PRD-3333"],
    });
    await waitFor(() => expect(bulkResult).toEqual({ success: true }));
  });

  it("opens the same dialog for a single row-menu delete as for a bulk selection", () => {
    const mutationFn = vi.fn().mockResolvedValue({});
    const { result } = renderHook(
      () =>
        useOptimisticDelete<TestRow>({
          deletable: makeDeletable(mutationFn),
        }),
      { wrapper: createWrapper() },
    );

    act(() => {
      result.current.requestDelete({ id: "PRD-2222", name: "Apples" });
    });

    const dialog = result.current.deleteDialog as AnyDialogElement;
    expect(dialog.props.items).toEqual([{ id: "PRD-2222", name: "Apples" }]);
  });
});
