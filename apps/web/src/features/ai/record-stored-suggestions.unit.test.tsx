import type { SuggestionReviewRow } from "@cubby/schemas/ai";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ai } from "~/integrations/tanstack-query/generated/catalog.gen";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import type { EntitySuggestionsOperations } from "./field-suggestion";
import {
  RecordFieldSuggestion,
  RecordSuggestionsBulkAction,
  RecordSuggestionsProvider,
  type StoredSuggestionOperations,
} from "./record-suggestions";

const rowId = "11111111-1111-4111-8111-111111111111";
const record = {
  id: testShortcode("product", "stored-suggestion"),
  _id: "33333333-3333-4333-8333-333333333333",
  categoryId: null,
};
const suggestion = (overrides: Partial<SuggestionReviewRow> = {}) =>
  ({
    id: rowId,
    runId: "22222222-2222-4222-8222-222222222222",
    entity: "product",
    recordId: "33333333-3333-4333-8333-333333333333",
    field: "categoryId",
    currentValue: null,
    suggestedValue: "CAT-2222",
    confidence: 0.97,
    model: "synthetic-model",
    kind: "addition",
    correctValue: null,
    ...overrides,
  }) satisfies SuggestionReviewRow;

function setup(
  stored: SuggestionReviewRow[],
  mutations: Pick<StoredSuggestionOperations, "accept" | "reject"> = {
    accept: vi.fn(async () => ({ id: rowId, status: "applied" as const })),
    reject: vi.fn(async () => ({ id: rowId, status: "rejected" as const })),
  },
) {
  const harness = createBrowserTestHarness();
  const operations: StoredSuggestionOperations = {
    list: vi.fn(async () => stored),
    ...mutations,
  };
  const liveOperations: EntitySuggestionsOperations = {
    suggestFields: ai.suggestFields.withTransport(async () => ({
      suggestions: {},
      outcomes: {},
    })),
  };
  const view = render(
    <RecordSuggestionsProvider
      entity="product"
      records={[record]}
      fieldKeys={["categoryId"]}
      operations={liveOperations}
      storedSuggestionOperations={operations}
    >
      <RecordFieldSuggestion
        record={record}
        field="categoryId"
        surface="cell"
        renderValue={(value) => (
          <span>{value === "CAT-2222" ? "Food" : String(value)}</span>
        )}
      >
        <span>Current category</span>
      </RecordFieldSuggestion>
      <RecordSuggestionsBulkAction records={[record]} />
    </RecordSuggestionsProvider>,
    { wrapper: harness.wrapper },
  );
  return { ...view, harness, operations };
}

describe("stored suggestions in generic list cells", () => {
  it("renders an Addition ghost with the field's display label", async () => {
    const { harness } = setup([suggestion()]);
    expect(await screen.findByText("Food")).toBeInTheDocument();
    expect(screen.queryByText("CAT-2222")).not.toBeInTheDocument();
    harness.dispose();
  });

  it("renders a Correction as the current value followed by its ghost", async () => {
    const { harness } = setup([
      suggestion({
        kind: "correction",
        currentValue: "CAT-1111",
        suggestedValue: "CAT-2222",
      }),
    ]);
    expect(await screen.findByText("Current category")).toBeInTheDocument();
    expect(await screen.findByText("Food")).toBeInTheDocument();
    expect(screen.getByLabelText("Suggested replacement")).toBeInTheDocument();
    harness.dispose();
  });

  it("accepts the stored Suggestion when its ghost is clicked", async () => {
    const accept = vi.fn(async () => ({
      id: rowId,
      status: "applied" as const,
    }));
    const { harness, operations } = setup([suggestion()], {
      accept,
      reject: vi.fn(),
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Accept suggested value",
      }),
    );
    await waitFor(() =>
      expect(operations.accept).toHaveBeenCalledWith(
        { id: rowId },
        expect.anything(),
      ),
    );
    harness.dispose();
  });

  it("records Reject as a Miss from the ghost menu", async () => {
    const reject = vi.fn(async () => ({
      id: rowId,
      status: "rejected" as const,
    }));
    const { harness, operations } = setup([suggestion()], {
      accept: vi.fn(),
      reject,
    });
    fireEvent.click(
      await screen.findByRole("button", { name: /suggestion actions/i }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: /reject/i }));
    await waitFor(() =>
      expect(operations.reject).toHaveBeenCalledWith(
        expect.objectContaining({ id: rowId }),
        expect.anything(),
      ),
    );
    harness.dispose();
  });

  it("accepts every pending Suggestion on the selected rows", async () => {
    const second = suggestion({
      id: "44444444-4444-4444-8444-444444444444",
      field: "manufacturer",
      suggestedValue: "Synthetic maker",
    });
    const accept = vi.fn(async ({ id }: { id: string }) => ({
      id,
      status: "applied" as const,
    }));
    const { harness, operations } = setup([suggestion(), second], {
      accept,
      reject: vi.fn(),
    });
    fireEvent.click(
      await screen.findByRole("button", { name: /accept suggestions/i }),
    );
    await waitFor(() => expect(operations.accept).toHaveBeenCalledTimes(2));
    expect(operations.accept).toHaveBeenCalledWith(
      expect.objectContaining({ id: second.id }),
      expect.anything(),
    );
    harness.dispose();
  });
});
