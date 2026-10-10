import type { SuggestionReviewRow } from "@cubby/schemas/ai";
import {
  suggestionReviewListInput,
  suggestionReviewListOut,
} from "@cubby/schemas/ai";
import { testShortcode } from "@cubby/schemas/testing";
import {
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ai } from "~/integrations/tanstack-query/generated/catalog.gen";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { MobileCardView } from "~/ui/data-table/MobileCardView";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  materializeCubbyColumns,
  useCubbyTable,
} from "~/ui/data-table/table-features";

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
  categoryId: null,
};
const suggestion = (overrides: Partial<SuggestionReviewRow> = {}) =>
  ({
    id: rowId,
    runId: "22222222-2222-4222-8222-222222222222",
    entity: "product",
    recordId: record.id,
    field: "categoryId",
    currentValue: null,
    suggestedValue: "CAT-2222",
    confidence: 0.97,
    model: "synthetic-model",
    kind: "addition",
    correctValue: null,
    ...overrides,
  }) satisfies SuggestionReviewRow;

function shortcodeSuggestion(recordId: string) {
  return suggestion({ recordId });
}

function validatedStoredOperations(stored: SuggestionReviewRow[]) {
  return {
    list: vi.fn(
      async (input: Parameters<StoredSuggestionOperations["list"]>[0]) => {
        suggestionReviewListInput.parse(input);
        return suggestionReviewListOut.parse(stored);
      },
    ),
    accept: vi.fn(async ({ id }: { id: string }) => ({
      id,
      status: "applied" as const,
    })),
    reject: vi.fn(async ({ id }: { id: string }) => ({
      id,
      status: "rejected" as const,
    })),
  } satisfies StoredSuggestionOperations;
}

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
  it("edits only the suggested field and commits through the correction operation", async () => {
    const harness = createBrowserTestHarness();
    const reject = vi.fn(async () => ({
      id: rowId,
      status: "rejected" as const,
    }));
    const expense = {
      id: testShortcode("expense", "suggestion-editor"),
      name: "Synthetic expense",
      cost: 10,
      costType: "services",
    };
    const operations = validatedStoredOperations([
      suggestion({
        entity: "expense",
        recordId: expense.id,
        field: "costType",
        currentValue: "services",
        suggestedValue: "materials",
      }),
    ]);
    operations.reject = reject;
    render(
      <RecordSuggestionsProvider
        entity="expense"
        records={[expense]}
        fieldKeys={["costType"]}
        operations={{
          suggestFields: ai.suggestFields.withTransport(async () => ({
            suggestions: {},
            outcomes: {},
          })),
        }}
        storedSuggestionOperations={operations}
      >
        <RecordFieldSuggestion record={expense} field="costType">
          <span>Current cost type</span>
        </RecordFieldSuggestion>
      </RecordSuggestionsProvider>,
      { wrapper: harness.wrapper },
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Suggestion actions" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Use a different value" }),
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Cost")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(reject).toHaveBeenCalledWith(
        {
          id: rowId,
          correctValue: "services",
        },
        expect.anything(),
      ),
    );
    harness.dispose();
  });

  it("keeps presentation-only fields out of a scoped correction editor", async () => {
    const harness = createBrowserTestHarness();
    const location = {
      id: testShortcode("location", "suggestion-editor"),
      name: "Synthetic room",
      type: "room",
      tags: [],
    };
    const operations = validatedStoredOperations([
      suggestion({
        entity: "location",
        recordId: location.id,
        field: "type",
        currentValue: "room",
        suggestedValue: "storage",
      }),
    ]);
    const reject = vi.fn(async () => ({
      id: rowId,
      status: "rejected" as const,
    }));
    operations.reject = reject;
    render(
      <RecordSuggestionsProvider
        entity="location"
        records={[location]}
        fieldKeys={["type"]}
        operations={{
          suggestFields: ai.suggestFields.withTransport(async () => ({
            suggestions: {},
            outcomes: {},
          })),
        }}
        storedSuggestionOperations={operations}
      >
        <RecordFieldSuggestion record={location} field="type">
          <span>Current type</span>
        </RecordFieldSuggestion>
      </RecordSuggestionsProvider>,
      { wrapper: harness.wrapper },
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Suggestion actions" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Use a different value" }),
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Type")).toBeInTheDocument();
    expect(screen.queryByText("Collections")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(reject).toHaveBeenCalledWith(
        { id: rowId, correctValue: "room" },
        expect.anything(),
      ),
    );
    harness.dispose();
  });

  it("renders a suggested field omitted by its bespoke presentation", async () => {
    const harness = createBrowserTestHarness();
    const transaction = {
      id: testShortcode("financialTransaction", "suggestion-editor"),
      amount: 10,
      transactionDate: new Date("2025-01-01T00:00:00.000Z"),
      evidenceExpectation: "receipt",
    };
    const operations = validatedStoredOperations([
      suggestion({
        entity: "financialTransaction",
        recordId: transaction.id,
        field: "evidenceExpectation",
        currentValue: "receipt",
        suggestedValue: "invoice",
      }),
    ]);
    const reject = vi.fn(async () => ({
      id: rowId,
      status: "rejected" as const,
    }));
    operations.reject = reject;
    render(
      <RecordSuggestionsProvider
        entity="financialTransaction"
        records={[transaction]}
        fieldKeys={["evidenceExpectation"]}
        operations={{
          suggestFields: ai.suggestFields.withTransport(async () => ({
            suggestions: {},
            outcomes: {},
          })),
        }}
        storedSuggestionOperations={operations}
      >
        <RecordFieldSuggestion record={transaction} field="evidenceExpectation">
          <span>Current expectation</span>
        </RecordFieldSuggestion>
      </RecordSuggestionsProvider>,
      { wrapper: harness.wrapper },
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Suggestion actions" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Use a different value" }),
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Evidence expectation")).toBeInTheDocument();
    expect(screen.queryByLabelText("Amount")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save transaction" }));
    await waitFor(() =>
      expect(reject).toHaveBeenCalledWith(
        { id: rowId, correctValue: "receipt" },
        expect.anything(),
      ),
    );
    harness.dispose();
  });

  it("loads a shortcode-only list row, renders its stored ghost, and bulk accepts it", async () => {
    const publicId = record.id;
    const harness = createBrowserTestHarness();
    const operations = validatedStoredOperations([
      shortcodeSuggestion(publicId),
    ]);
    render(
      <RecordSuggestionsProvider
        entity="product"
        records={[record]}
        fieldKeys={["categoryId"]}
        operations={{
          suggestFields: ai.suggestFields.withTransport(async () => ({
            suggestions: {},
            outcomes: {},
          })),
        }}
        storedSuggestionOperations={operations}
      >
        <RecordFieldSuggestion
          record={record}
          field="categoryId"
          surface="cell"
          renderValue={(value) => (
            <span>{String(value) === "CAT-2222" ? "Food" : String(value)}</span>
          )}
        >
          <span>Current category</span>
        </RecordFieldSuggestion>
        <RecordSuggestionsBulkAction records={[record]} />
      </RecordSuggestionsProvider>,
      { wrapper: harness.wrapper },
    );

    expect(await screen.findByText("Food")).toBeInTheDocument();
    expect(operations.list).toHaveBeenCalledWith({
      entity: "product",
      recordIds: [publicId],
      fields: expect.any(Array),
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Accept suggestions (1)" }),
    );
    await waitFor(() =>
      expect(operations.accept).toHaveBeenCalledWith(
        { id: rowId },
        expect.anything(),
      ),
    );
    harness.dispose();
  });

  it("shows and accepts a stored Addition in a mobile card", async () => {
    const harness = createBrowserTestHarness();
    const cardRecord = { ...record, name: "Synthetic product" };
    const helper = createCubbyColumnHelper<typeof cardRecord>();
    const columns = createCubbyColumnCollection<typeof cardRecord>((add) => {
      add(
        helper.accessor("name", {
          header: "Name",
          meta: { mobile: { slot: "title" } },
        }),
      );
    });
    const { result } = renderHook(() =>
      useCubbyTable({
        data: [cardRecord],
        columns: materializeCubbyColumns(columns),
        getRowId: (row) => row.id,
        enableRowSelection: false,
      }),
    );
    const operations = validatedStoredOperations([
      shortcodeSuggestion(cardRecord.id),
    ]);

    render(
      <RecordSuggestionsProvider
        entity="product"
        records={[cardRecord]}
        fieldKeys={["categoryId"]}
        operations={{
          suggestFields: ai.suggestFields.withTransport(async () => ({
            suggestions: {},
            outcomes: {},
          })),
        }}
        storedSuggestionOperations={operations}
      >
        <MobileCardView table={result.current} />
      </RecordSuggestionsProvider>,
      { wrapper: harness.wrapper },
    );

    expect(
      await screen.findByRole("button", { name: "Accept suggested value" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Accept suggested value" }),
    );
    await waitFor(() => expect(operations.accept).toHaveBeenCalledOnce());
    harness.dispose();
  });

  it("shows the current value before a stored Correction in a mobile card", async () => {
    const harness = createBrowserTestHarness();
    const cardRecord = { ...record, name: "Synthetic product" };
    const helper = createCubbyColumnHelper<typeof cardRecord>();
    const columns = createCubbyColumnCollection<typeof cardRecord>((add) => {
      add(
        helper.accessor("name", {
          header: "Name",
          meta: { mobile: { slot: "title" } },
        }),
      );
    });
    const { result } = renderHook(() =>
      useCubbyTable({
        data: [cardRecord],
        columns: materializeCubbyColumns(columns),
        getRowId: (row) => row.id,
        enableRowSelection: false,
      }),
    );
    const operations = validatedStoredOperations([
      suggestion({
        recordId: cardRecord.id,
        field: "name",
        currentValue: "Synthetic product",
        suggestedValue: "Replacement product",
        kind: "correction",
      }),
    ]);

    render(
      <RecordSuggestionsProvider
        entity="product"
        records={[cardRecord]}
        fieldKeys={["name"]}
        operations={{
          suggestFields: ai.suggestFields.withTransport(async () => ({
            suggestions: {},
            outcomes: {},
          })),
        }}
        storedSuggestionOperations={operations}
      >
        <MobileCardView table={result.current} />
      </RecordSuggestionsProvider>,
      { wrapper: harness.wrapper },
    );

    expect(await screen.findByText("Replacement product")).toBeInTheDocument();
    expect(screen.getAllByText("Synthetic product").length).toBeGreaterThan(1);
    expect(screen.getByLabelText("Suggested replacement")).toBeInTheDocument();
    harness.dispose();
  });

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
