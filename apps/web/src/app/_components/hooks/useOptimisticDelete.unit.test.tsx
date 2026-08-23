import type { PreviewOperation } from "@cubby/schemas/entity-integrity";
import { publicImpactItemSchema } from "@cubby/schemas/entity-integrity";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CubbyRow as Row } from "../data-table/table-features";

/**
 * Pins the fix for the two-tier bug: bulk delete (toolbar) and single-row
 * delete (row menu / swipe) are now literally the same flow over a list of
 * targets — one preview query, one dialog, one `blocked` gate — instead of
 * bulk delete skipping the impact preview and routing through
 * `BulkActionBar`'s generic "are you sure" dialog.
 *
 * These treat the memoized `deleteDialog` element as data: reading its props
 * directly is more robust than rendering the underlying base-ui portal dialog
 * in jsdom, and it's a faithful check of what this hook is actually
 * responsible for — wiring the right ids and the right gate into the shared
 * dialog, not the dialog's own rendering (that's `BulkActionDialog`'s and
 * `OperationImpact`'s job, already covered elsewhere).
 */

const mocks = vi.hoisted(() => ({
  previewQueryFn: vi.fn(),
  commandMutation: vi.fn(),
}));

vi.mock("~/integrations/trpc/react", () => ({
  useTRPC: () => ({
    entityIntegrity: {
      previewOperation: {
        queryOptions: (input: {
          operation: string;
          entity: string;
          ids?: string[];
        }) => ({
          queryKey: ["entityIntegrity.previewOperation", input],
          queryFn: () => mocks.previewQueryFn(input),
        }),
      },
    },
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

const basePreview = (
  over: Partial<PreviewOperation> = {},
): PreviewOperation => ({
  operation: "delete",
  entity: "product",
  mode: "soft",
  targetCount: 2,
  canProceed: true,
  blockers: [],
  changes: [],
  sideEffects: [],
  generatedAt: "2026-08-04T00:00:00.000Z",
  ...over,
});

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
  mocks.previewQueryFn.mockReset();
  mocks.commandMutation.mockReset();
});

// biome-ignore lint/suspicious/noExplicitAny: reading props off a memoized dialog element for assertions
type AnyDialogElement = ReactElement<any>;

describe("useOptimisticDelete", () => {
  it("previews the whole bulk selection, not just the first row", async () => {
    mocks.previewQueryFn.mockResolvedValue(basePreview());
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

    await waitFor(() =>
      expect(mocks.previewQueryFn).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "delete",
          entity: "product",
          ids: ["PRD-2222", "PRD-3333"],
        }),
      ),
    );

    const dialog = result.current.deleteDialog as AnyDialogElement;
    expect(dialog.props.items).toEqual([
      { id: "PRD-2222", name: "Apples" },
      { id: "PRD-3333", name: "Bananas" },
    ]);
  });

  it("blocks confirmation when a bulk selection includes a since-deleted row", async () => {
    // Mirrors #619: a target id that no longer resolves to a live row comes
    // back as an ordinary blocker, not a silently-empty preview. A bulk
    // selection containing one must surface as blocked, same as it would for
    // a single-row delete of that id.
    mocks.previewQueryFn.mockResolvedValue(
      basePreview({
        canProceed: false,
        blockers: [
          // Parsed, not cast: `blockers[]` is the branded wire type, so the
          // fixture arrives the way real data does.
          publicImpactItemSchema.parse({
            code: "target-not-found",
            effect: "block",
            label: "PRD-9999 no longer exists",
            description: "This id does not resolve to a live row.",
            total: 1,
            byTargetId: { "PRD-9999": 1 },
          }),
        ],
      }),
    );
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
        row({ id: "PRD-9999", name: "Ghost" }),
      ]);
    });

    await waitFor(() => {
      const dialog = result.current.deleteDialog as AnyDialogElement;
      expect(dialog.props.blocked).toBe(true);
    });
    expect(mutationFn).not.toHaveBeenCalled();
  });

  it("resolves the bulk action's held-open promise as unsuccessful on cancel, without deleting", async () => {
    mocks.previewQueryFn.mockResolvedValue(basePreview());
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
    mocks.previewQueryFn.mockResolvedValue(basePreview());
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

    await waitFor(() => expect(mocks.previewQueryFn).toHaveBeenCalled());

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
