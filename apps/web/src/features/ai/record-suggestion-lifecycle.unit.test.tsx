import type { FieldSuggestionsInput } from "@cubby/schemas/ai";
import { productTopLevelOut } from "@cubby/schemas/product";
import { testShortcode } from "@cubby/schemas/testing";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { EntityMutationPort } from "~/entity/editing/types";
import { createEntityMutationPort } from "~/entity/editing/use-entity-commands";
import { exactRippleTags } from "~/integrations/tanstack-query/cache-tags";
import { ai } from "~/integrations/tanstack-query/generated/catalog.gen";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";

import type { EntitySuggestionsOperations } from "./field-suggestion";
import {
  RecordFieldSuggestion,
  RecordSuggestionsProvider,
  type StoredSuggestionOperations,
} from "./record-suggestions";

const id = testShortcode("product", "lifecycle");
const categoryId = testShortcode("productCategory", "food");
const ingredientId = testShortcode("ingredient", "apple");
type PageRecord = Pick<
  z.output<typeof productTopLevelOut>,
  "id" | "name" | "manufacturer" | "categoryId"
> & { ingredient?: null };
const baseRecord = {
  id,
  name: "Synthetic apple",
  manufacturer: "Synthetic maker",
  categoryId: null,
};
const proposal = {
  value: categoryId,
  label: "Synthetic food",
  detail: null,
  confidence: "high" as const,
  probability: 0.97,
  reasoning: "Synthetic evidence",
  alternatives: [],
  operation: "set" as const,
  removals: [],
};
const stored: StoredSuggestionOperations = {
  list: async () => [],
  accept: async ({ id }) => ({ id, status: "applied" }),
  acceptMany: async () => [],
  reject: async ({ id }) => ({ id, status: "rejected" }),
};
let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

function Page({
  record = baseRecord,
  extra = false,
  operations,
  storedOperations = stored,
  readRecord,
  mutationPort,
}: {
  record?: PageRecord;
  extra?: boolean;
  operations: EntitySuggestionsOperations;
  storedOperations?: StoredSuggestionOperations;
  readRecord?: () => Promise<PageRecord | null>;
  mutationPort?: EntityMutationPort;
}) {
  return (
    <RecordSuggestionsProvider
      entity="product"
      records={
        extra
          ? [record, { ...record, id: testShortcode("product", "extra") }]
          : [record]
      }
      fieldKeys={["categoryId", "ingredientId"]}
      operations={operations}
      storedSuggestionOperations={storedOperations}
      readRecord={readRecord}
      mutationPort={mutationPort}
    >
      <RecordFieldSuggestion record={record} field="categoryId" surface="cell">
        <span>{record.categoryId ? "Saved category" : "Empty category"}</span>
      </RecordFieldSuggestion>
      <RecordFieldSuggestion
        record={record}
        field="ingredientId"
        surface="cell"
      >
        <span>Empty ingredient</span>
      </RecordFieldSuggestion>
    </RecordSuggestionsProvider>
  );
}

const categoryButton = () =>
  screen.getByRole("button", {
    name: "Accept suggested value: Synthetic food",
  });
const ingredientButton = () =>
  screen.getByRole("button", {
    name: "Accept suggested value: Synthetic ingredient",
  });
function operationsReturning(calls: FieldSuggestionsInput[]) {
  return {
    suggestFields: ai.suggestFields.withTransport(async ({ input }) => {
      calls.push(input);
      return {
        suggestions: Object.fromEntries(
          input.targets.map((target) => [
            target,
            target === "ingredientId"
              ? {
                  ...proposal,
                  value: ingredientId,
                  label: "Synthetic ingredient",
                }
              : proposal,
          ]),
        ),
      };
    }),
  };
}

describe("suggestion lifecycle", () => {
  it("refreshes only the refused finance question and preserves other field answers", async () => {
    const expenseId = testShortcode("expense", "finance-lifecycle");
    const spendingCategoryId = testShortcode(
      "spendingCategory",
      "finance-lifecycle",
    );
    const record = {
      id: expenseId,
      name: "Synthetic supplies",
      vendor: "Synthetic supplier",
      notes: null,
      lineKind: "principal",
      costType: "materials",
      spendingCategoryId: null,
    };
    const calls: FieldSuggestionsInput[] = [];
    const operations = {
      suggestFields: ai.suggestFields.withTransport(async ({ input }) => {
        calls.push(input);
        return {
          suggestions: Object.fromEntries(
            input.targets.map((field) => [
              field,
              field === "spendingCategoryId"
                ? {
                    ...proposal,
                    value: spendingCategoryId,
                    label: "Synthetic spending",
                    financeReview: {
                      entity: "expense" as const,
                      entityId: expenseId,
                      fingerprint: "a".repeat(64),
                    },
                  }
                : { ...proposal, value: "tools", label: "Tools" },
            ]),
          ),
        };
      }),
      applyFinanceCategorySuggestion:
        ai.applyFinanceCategorySuggestion.withTransport(async () => {
          throw new Error("Synthetic finance evidence changed");
        }),
    };
    render(
      <RecordSuggestionsProvider
        entity="expense"
        records={[record]}
        fieldKeys={["spendingCategoryId", "costType"]}
        operations={operations}
        storedSuggestionOperations={stored}
      >
        <RecordFieldSuggestion
          record={record}
          field="spendingCategoryId"
          surface="cell"
        >
          <span>Empty spending category</span>
        </RecordFieldSuggestion>
        <RecordFieldSuggestion record={record} field="costType" surface="cell">
          <span>Materials</span>
        </RecordFieldSuggestion>
      </RecordSuggestionsProvider>,
      { wrapper: harness.wrapper },
    );
    const spendingButton = () =>
      screen.getByRole("button", {
        name: "Accept suggested value: Synthetic spending",
      });
    await waitFor(() => expect(spendingButton()).toBeEnabled());
    await waitFor(() =>
      expect(
        calls.filter((call) => call.targets.includes("costType")),
      ).toHaveLength(1),
    );
    fireEvent.click(spendingButton());
    await waitFor(() => expect(spendingButton()).toBeEnabled());
    expect(
      calls.filter((call) => call.targets.includes("spendingCategoryId")),
    ).toHaveLength(2);
    expect(
      calls.filter((call) => call.targets.includes("costType")),
    ).toHaveLength(1);
  });

  it("retains a loaded proposal and exposes diagnostics when the stored-suggestion refresh fails", async () => {
    const list = vi
      .fn<StoredSuggestionOperations["list"]>()
      .mockResolvedValueOnce([])
      .mockRejectedValue(new Error("Synthetic stored-suggestion refusal"));
    const calls: FieldSuggestionsInput[] = [];
    render(
      <Page
        operations={operationsReturning(calls)}
        storedOperations={{ ...stored, list }}
      />,
      { wrapper: harness.wrapper },
    );
    await waitFor(() => expect(categoryButton()).toBeEnabled());
    const count = calls.length;
    await act(async () =>
      invalidateOperationTags(
        harness.queryClient,
        exactRippleTags([["product"]]),
      ),
    );
    expect(
      await screen.findByText("Synthetic stored-suggestion refusal"),
    ).toBeVisible();
    expect(categoryButton()).toBeEnabled();
    expect(calls).toHaveLength(count);
  });

  it("keeps a loaded row's proposal usable while a larger page checks stored suggestions", async () => {
    const pending = Promise.withResolvers<[]>();
    const list = vi.fn(
      async ({
        recordIds,
      }: Parameters<StoredSuggestionOperations["list"]>[0]) =>
        recordIds.length > 1 ? pending.promise : [],
    );
    const calls: FieldSuggestionsInput[] = [];
    const operations = operationsReturning(calls);
    const view = render(
      <Page operations={operations} storedOperations={{ ...stored, list }} />,
      { wrapper: harness.wrapper },
    );
    await waitFor(() => expect(categoryButton()).toBeEnabled());
    const count = calls.length;
    view.rerender(
      <Page
        extra
        operations={operations}
        storedOperations={{ ...stored, list }}
      />,
    );
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(categoryButton()).toBeEnabled();
    expect(calls).toHaveLength(count);
    await act(async () => pending.resolve([]));
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
    expect(categoryButton()).toBeEnabled();
  });

  it("does not restart category suggestions when a deferred ingredient projection arrives", async () => {
    const pending = Promise.withResolvers<[]>();
    const calls: FieldSuggestionsInput[] = [];
    const operations = {
      suggestFields: ai.suggestFields.withTransport(async ({ input }) => {
        calls.push(input);
        if (input.targets.includes("ingredientId")) await pending.promise;
        return { suggestions: { categoryId: proposal } };
      }),
    };
    const view = render(<Page operations={operations} />, {
      wrapper: harness.wrapper,
    });
    await waitFor(() => expect(categoryButton()).toBeEnabled());
    view.rerender(
      <Page
        record={{ ...baseRecord, ingredient: null }}
        operations={operations}
      />,
    );
    await waitFor(() =>
      expect(calls.some((call) => call.targets.includes("ingredientId"))).toBe(
        true,
      ),
    );
    expect(categoryButton()).toBeEnabled();
    expect(categoryButton()).toHaveAttribute("aria-busy", "false");
    expect(
      calls.filter((call) => call.targets.includes("categoryId")),
    ).toHaveLength(1);
    await act(async () => pending.resolve([]));
  });

  it("isolates the pending state of another suggestion request in the same row", async () => {
    const pending = Promise.withResolvers<[]>();
    const operations = {
      suggestFields: ai.suggestFields.withTransport(async ({ input }) => {
        if (input.basisMode === "provided") await pending.promise;
        return {
          suggestions: {
            ingredientId: {
              ...proposal,
              value: ingredientId,
              label: "Synthetic ingredient",
            },
          },
        };
      }),
    };
    render(
      <Page
        record={{ ...baseRecord, categoryId, ingredient: null }}
        operations={operations}
      />,
      { wrapper: harness.wrapper },
    );
    await waitFor(() => expect(ingredientButton()).toBeEnabled());
    expect(ingredientButton()).toHaveAttribute("aria-busy", "false");
    await act(async () => pending.resolve([]));
  });

  it("shows the accepted value immediately, retains it through refresh, and leaves sibling proposals usable", async () => {
    const read = Promise.withResolvers<typeof baseRecord>();
    const write = Promise.withResolvers<void>();
    const calls: FieldSuggestionsInput[] = [];
    const record = { ...baseRecord, ingredient: null };
    const operations = operationsReturning(calls);
    const execute = vi.fn(async () => {
      await write.promise;
      return {
        action: "update" as const,
        entity: "product" as const,
        item: { ...mock(productTopLevelOut, { seed: 1 }), id, categoryId },
        sideEffects: {},
      };
    });
    const view = render(
      <Page
        record={record}
        operations={operations}
        readRecord={() => read.promise}
        mutationPort={createEntityMutationPort({ execute })}
      />,
      { wrapper: harness.wrapper },
    );
    await waitFor(() => expect(ingredientButton()).toBeEnabled());
    fireEvent.click(categoryButton());
    expect(
      screen.queryByRole("button", {
        name: "Accept suggested value: Synthetic food",
      }),
    ).toBeNull();
    expect(screen.getByText("Synthetic food")).toBeVisible();
    expect(ingredientButton()).toBeEnabled();
    await act(async () => read.resolve(record));
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await act(async () => write.resolve());
    await act(async () =>
      invalidateOperationTags(
        harness.queryClient,
        exactRippleTags([["product"]]),
      ),
    );
    expect(screen.getByText("Synthetic food")).toBeVisible();
    expect(ingredientButton()).toBeEnabled();
    expect(
      calls.filter((call) => call.targets.includes("ingredientId")),
    ).toHaveLength(1);
    const savedRecord = {
      ...record,
      categoryId,
      category: { id: categoryId, name: "Synthetic food" },
    };
    view.rerender(<Page record={savedRecord} operations={operations} />);
    await screen.findByText("Saved category");
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
    expect(
      calls.filter((call) => call.targets.includes("categoryId")),
    ).toHaveLength(1);
    view.rerender(
      <Page
        record={{ ...savedRecord, name: "Synthetic changed identity" }}
        operations={operations}
      />,
    );
    await waitFor(() =>
      expect(
        calls.filter((call) => call.targets.includes("categoryId")),
      ).toHaveLength(2),
    );
  });

  it("restores the proposal after a failed acceptance without disturbing its sibling", async () => {
    const read = Promise.withResolvers<typeof baseRecord>();
    const operations = operationsReturning([]);
    render(
      <Page
        record={{ ...baseRecord, ingredient: null }}
        operations={operations}
        readRecord={() => read.promise}
      />,
      { wrapper: harness.wrapper },
    );
    await waitFor(() => expect(ingredientButton()).toBeEnabled());
    fireEvent.click(categoryButton());
    expect(
      screen.queryByRole("button", {
        name: "Accept suggested value: Synthetic food",
      }),
    ).toBeNull();
    await act(async () => read.reject(new Error("Synthetic read refusal")));
    await waitFor(() => expect(categoryButton()).toBeEnabled());
    expect(ingredientButton()).toBeEnabled();
  });
});
