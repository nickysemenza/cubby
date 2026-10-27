import type { SuggestionReviewRow } from "@cubby/schemas/ai";
import { suggestionReviewRowSchema } from "@cubby/schemas/ai";
import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import { shortcode } from "@cubby/schemas/identifiers";
import {
  productCategorySummary,
  type ProductCategorySummary,
} from "@cubby/schemas/product-category-fields";
import {
  SUGGESTION_LIST_PAGE_MAX,
  suggestionListInput,
} from "@cubby/schemas/suggestion-list";
import { testShortcode } from "@cubby/schemas/testing";
import { parseShortcode } from "@cubby/shared";
import {
  fireEvent,
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { Profiler } from "react";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { fieldValueFixture } from "~/entity/fields/field-envelope.fixtures";
import { MobileCardView } from "~/entity/table/mobile-card-view";
import { ai } from "~/integrations/tanstack-query/generated/catalog/ai.gen";
import { suggestions } from "~/integrations/tanstack-query/generated/catalog/suggestions.gen";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
  materializeCubbyColumns,
  useCubbyTable,
} from "~/ui/data-table/table-features";

import type { EntitySuggestionsOperations } from "./field-suggestion";
import { ProposalCount, ProposalCountProvider } from "./proposal-counts";
import {
  everyPendingSuggestion,
  RecordFieldSuggestion,
  RecordSuggestionsBulkAction,
  RecordSuggestionsProvider,
  type StoredSuggestionOperations,
} from "./record-suggestions";

function recordFixture<T extends { id: string }>(input: T) {
  const entity = parseShortcode(input.id)?.type;
  if (!entity) throw new Error("Synthetic record identity missing");
  const row = z.looseObject({ id: z.string() }).parse(input);
  const schemas = entityFieldEnvelopeSchemas[entity].detail.shape.fields.shape;
  const fields = z.record(z.string(), z.unknown()).parse(row.fields ?? {});
  for (const [key, schema] of Object.entries(schemas)) {
    if (!(schema instanceof z.ZodType))
      throw new Error("Synthetic field schema missing");
    if (Object.hasOwn(row, key))
      fields[key] = fieldValueFixture(schema, row[key]);
    else {
      const nestedKey = key.replace(/Ids?$/u, "");
      if (
        !Object.hasOwn(fields, key) &&
        nestedKey !== key &&
        Object.hasOwn(row, nestedKey)
      ) {
        const nested = z
          .object({ id: z.string() })
          .nullable()
          .safeParse(row[nestedKey]);
        if (nested.success)
          fields[key] = fieldValueFixture(schema, nested.data?.id ?? null);
      }
    }
  }
  for (const [key, schema] of Object.entries(schemas)) {
    if (schema instanceof z.ZodType && !Object.hasOwn(fields, key))
      fields[key] = fieldValueFixture(schema, undefined);
  }
  const result = { ...input, fields };
  for (const key of Object.keys(schemas)) Reflect.deleteProperty(result, key);
  return result;
}

const rowId = "11111111-1111-4111-8111-111111111111";
const record = recordFixture({
  id: testShortcode("product", "stored-suggestion"),
  categoryId: null,
});
const suggestion = (overrides: Partial<SuggestionReviewRow> = {}) =>
  ({
    id: rowId,
    runId: shortcode("RUN-2222"),
    entity: "product",
    recordId: record.id,
    field: "categoryId",
    currentValue: null,
    suggestedValue: "CAT-2222",
    confidence: 0.97,
    model: "synthetic-model",
    kind: "addition",
    status: "pending",
    runnerUpValue: null,
    runnerUpConfidence: null,
    correctValue: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
    assessmentId: overrides.assessmentId ?? overrides.id ?? rowId,
  }) satisfies SuggestionReviewRow;

function shortcodeSuggestion(recordId: string) {
  return suggestion({ recordId });
}

/** The cross-family list input the production read sends for a list page. */
const fieldListInput = (
  input: Parameters<StoredSuggestionOperations["list"]>[0] & {
    cursor?: string;
    limit?: number;
  },
) =>
  suggestionListInput.parse({
    family: "field",
    entity: input.entity,
    recordIds: input.recordIds,
    where: { field: { in: input.fields } },
    ...(input.limit ? { limit: input.limit } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
  });

function validatedStoredOperations(stored: SuggestionReviewRow[]) {
  return {
    list: vi.fn(
      async (input: Parameters<StoredSuggestionOperations["list"]>[0]) => {
        fieldListInput(input);
        return suggestionReviewRowSchema.array().parse(stored);
      },
    ),
    review: vi.fn(
      async ({
        assessmentId,
        intent,
      }: {
        assessmentId: string;
        intent: string;
      }) => ({
        assessmentId,
        feedbackId: "55555555-5555-4555-8555-555555555555",
        status: "recorded",
        applied: intent === "apply",
      }),
    ),
    reviewBatch: vi.fn(
      async ({ items }: { items: { assessmentId: string }[] }) =>
        items.map(({ assessmentId }) => ({
          assessmentId,
          feedbackId: "55555555-5555-4555-8555-555555555555",
          status: "applied",
          applied: true,
          ok: true as const,
        })),
    ),
    settled: async ({ questions }) => ({
      results: questions.map(() => ({
        ok: true as const,
        value: { outcome: null, revision: null },
      })),
    }),
  } satisfies StoredSuggestionOperations;
}

function setup(
  stored: SuggestionReviewRow[],
  mutations: Pick<StoredSuggestionOperations, "review" | "reviewBatch"> = {
    review: vi.fn(async ({ assessmentId, intent }) => ({
      assessmentId,
      feedbackId: "55555555-5555-4555-8555-555555555555",
      status: "recorded",
      applied: intent === "apply",
    })),
    reviewBatch: vi.fn(async () => []),
  },
  currentCategory?: ProductCategorySummary,
) {
  const currentRecord = currentCategory
    ? recordFixture({
        ...record,
        categoryId: currentCategory.id,
        category: currentCategory,
      })
    : record;
  const harness = createBrowserTestHarness();
  const operations: StoredSuggestionOperations = {
    list: vi.fn(async () => stored),
    settled: async ({ questions }) => ({
      results: questions.map(() => ({
        ok: true as const,
        value: { outcome: null, revision: null },
      })),
    }),
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
      records={[currentRecord]}
      fieldKeys={["categoryId"]}
      operations={liveOperations}
      storedSuggestionOperations={operations}
    >
      <RecordFieldSuggestion
        record={currentRecord}
        field="categoryId"
        surface="cell"
        renderValue={(value) => (
          <span>{value === "CAT-2222" ? "Food" : String(value)}</span>
        )}
      >
        <span>Current category</span>
      </RecordFieldSuggestion>
      <RecordSuggestionsBulkAction records={[currentRecord]} />
    </RecordSuggestionsProvider>,
    { wrapper: harness.wrapper },
  );
  return { ...view, harness, operations };
}

describe("stored suggestions in generic list cells", () => {
  it("updates proposal counts without subscribing unrelated fields", async () => {
    const harness = createBrowserTestHarness();
    const identityReads = vi.fn();
    const unrelatedRecord = {
      get id() {
        identityReads();
        return record.id;
      },
    };
    const key = suggestions.recordCounts.queryOptions({
      recordIds: [record.id],
    }).queryKey;
    harness.queryClient.setQueryData(key, {
      records: [{ id: record.id, pending: 1 }],
    });
    const commits = vi.fn();
    const view = render(
      <ProposalCountProvider entity="product" records={[record]}>
        <Profiler id="unrelated-count-field" onRender={commits}>
          <ProposalCount record={unrelatedRecord} field="expenseCount">
            <span>12 expenses</span>
          </ProposalCount>
        </Profiler>
        <ProposalCount record={record} field="name">
          <span>Product title</span>
        </ProposalCount>
        <ProposalCount record={record}>
          <span>Mobile title</span>
        </ProposalCount>
      </ProposalCountProvider>,
      { wrapper: harness.wrapper },
    );
    try {
      await screen.findAllByRole("button", { name: "1 pending suggestion" });
      const before = commits.mock.calls.length;
      const readsBefore = identityReads.mock.calls.length;
      await act(async () => {
        harness.queryClient.setQueryData(key, {
          records: [{ id: record.id, pending: 2 }],
        });
      });
      await screen.findAllByRole("button", { name: "2 pending suggestions" });
      expect(commits).toHaveBeenCalledTimes(before);
      expect(identityReads).toHaveBeenCalledTimes(readsBefore);
      expect(screen.getByText("12 expenses")).toBeVisible();
    } finally {
      view.unmount();
      harness.dispose();
    }
  });
  it("does not update an unsuggestible field when another field's stored suggestion arrives", async () => {
    const harness = createBrowserTestHarness();
    const pending = Promise.withResolvers<SuggestionReviewRow[]>();
    const operations: StoredSuggestionOperations = {
      ...validatedStoredOperations([]),
      list: vi.fn(() => pending.promise),
    };
    const commits = vi.fn();
    const view = render(
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
        <Profiler id="unrelated-field" onRender={commits}>
          <RecordFieldSuggestion record={record} field="expenseCount">
            <span>12 expenses</span>
          </RecordFieldSuggestion>
        </Profiler>
        <RecordFieldSuggestion
          record={record}
          field="categoryId"
          renderValue={() => <span>Suggested category</span>}
        >
          <span>Current category</span>
        </RecordFieldSuggestion>
      </RecordSuggestionsProvider>,
      { wrapper: harness.wrapper },
    );
    try {
      await waitFor(() => expect(operations.list).toHaveBeenCalled());
      const before = commits.mock.calls.length;
      pending.resolve([suggestion()]);
      await screen.findByText("Suggested category");
      expect(commits).toHaveBeenCalledTimes(before);
      expect(screen.getByText("12 expenses")).toBeVisible();
    } finally {
      view.unmount();
      harness.dispose();
    }
  });

  it.each([false, true])(
    "withholds a stored ancestor correction from cell and bulk acceptance (hierarchy loaded: %s)",
    async (hierarchyLoaded) => {
      const harness = createBrowserTestHarness();
      const base = recordFixture({
        ...record,
        name: "Synthetic driver",
        categoryId: "CAT-BBBB",
      });
      const specific = hierarchyLoaded
        ? {
            ...base,
            category: {
              id: "CAT-BBBB",
              name: "Drivers",
              fields: {
                path: fieldValueFixture(
                  productCategorySummary.shape.fields.shape.path,
                  [
                    { id: "CAT-AAAA", name: "Tools" },
                    { id: "CAT-BBBB", name: "Drivers" },
                  ],
                ),
              },
            },
          }
        : base;
      const operations = validatedStoredOperations([
        suggestion({
          recordId: specific.id,
          currentValue: "CAT-BBBB",
          suggestedValue: "CAT-AAAA",
          kind: "correction",
        }),
      ]);
      render(
        <RecordSuggestionsProvider
          entity="product"
          records={[specific]}
          fieldKeys={["categoryId"]}
          operations={{
            suggestFields: ai.suggestFields.withTransport(async () => ({
              suggestions: {},
              outcomes: {
                categoryId: {
                  kind: "evaluated",
                  answer: "none",
                  confidence: "high",
                  probability: 0.97,
                  alternatives: [],
                },
              },
            })),
          }}
          storedSuggestionOperations={operations}
        >
          <RecordFieldSuggestion
            record={specific}
            field="categoryId"
            surface="cell"
            renderValue={() => <span>Broad category</span>}
          >
            <span>Tools / Drivers</span>
          </RecordFieldSuggestion>
          <RecordSuggestionsBulkAction records={[specific]} />
        </RecordSuggestionsProvider>,
        { wrapper: harness.wrapper },
      );
      await waitFor(() => expect(operations.list).toHaveBeenCalled());
      await screen.findByText("No suggestions · 1 field checked");
      expect(
        screen.queryByRole("button", { name: /^Accept suggested value/ }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: /^Accept suggestions/ }),
      ).toBeNull();
      expect(screen.getByText("Tools / Drivers")).toBeVisible();
      harness.dispose();
    },
  );

  it("edits only the suggested field and commits through the correction operation", async () => {
    const harness = createBrowserTestHarness();
    const review = vi.fn(
      async ({ assessmentId }: { assessmentId: string }) => ({
        assessmentId,
        feedbackId: "55555555-5555-4555-8555-555555555555",
        status: "applied",
        applied: true,
      }),
    );
    const expense = recordFixture({
      id: testShortcode("expense", "suggestion-editor"),
      name: "Synthetic expense",
      cost: 10,
      costType: "services",
    });
    const operations = validatedStoredOperations([
      suggestion({
        entity: "expense",
        recordId: expense.id,
        field: "costType",
        currentValue: "services",
        suggestedValue: "materials",
      }),
    ]);
    operations.review = review;
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

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Use a different value…" }),
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Cost")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(review).toHaveBeenCalledWith(
        expect.objectContaining({
          assessmentId: rowId,
          verdict: "wrong",
          correction: { present: true, value: "services" },
          intent: "apply",
        }),
      ),
    );
    harness.dispose();
  });

  it("keeps presentation-only fields out of a scoped correction editor", async () => {
    const harness = createBrowserTestHarness();
    const location = recordFixture({
      id: testShortcode("location", "suggestion-editor"),
      name: "Synthetic room",
      type: "room",
      tags: [],
    });
    const operations = validatedStoredOperations([
      suggestion({
        entity: "location",
        recordId: location.id,
        field: "type",
        currentValue: "room",
        suggestedValue: "cabinet",
      }),
    ]);
    const review = vi.fn(
      async ({ assessmentId }: { assessmentId: string }) => ({
        assessmentId,
        feedbackId: "55555555-5555-4555-8555-555555555555",
        status: "applied",
        applied: true,
      }),
    );
    operations.review = review;
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

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Use a different value…" }),
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Type")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(review).toHaveBeenCalledWith(
        expect.objectContaining({
          assessmentId: rowId,
          verdict: "wrong",
          correction: { present: true, value: "room" },
          intent: "apply",
        }),
      ),
    );
    harness.dispose();
  });

  it("renders a suggested field omitted by its bespoke presentation", async () => {
    const harness = createBrowserTestHarness();
    const transaction = recordFixture({
      id: testShortcode("financialTransaction", "suggestion-editor"),
      amount: 10,
      transactionDate: new Date("2025-01-01T00:00:00.000Z"),
      itemizationExpectation: "required",
    });
    const operations = validatedStoredOperations([
      suggestion({
        entity: "financialTransaction",
        recordId: transaction.id,
        field: "itemizationExpectation",
        currentValue: "required",
        suggestedValue: "not_expected",
      }),
    ]);
    const review = vi.fn(
      async ({ assessmentId }: { assessmentId: string }) => ({
        assessmentId,
        feedbackId: "55555555-5555-4555-8555-555555555555",
        status: "applied",
        applied: true,
      }),
    );
    operations.review = review;
    render(
      <RecordSuggestionsProvider
        entity="financialTransaction"
        records={[transaction]}
        fieldKeys={["itemizationExpectation"]}
        operations={{
          suggestFields: ai.suggestFields.withTransport(async () => ({
            suggestions: {},
            outcomes: {},
          })),
        }}
        storedSuggestionOperations={operations}
      >
        <RecordFieldSuggestion
          record={transaction}
          field="itemizationExpectation"
        >
          <span>Current expectation</span>
        </RecordFieldSuggestion>
      </RecordSuggestionsProvider>,
      { wrapper: harness.wrapper },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Review" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Use a different value…" }),
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Itemization expectation"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Amount")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save transaction" }));
    await waitFor(() =>
      expect(review).toHaveBeenCalledWith(
        expect.objectContaining({
          assessmentId: rowId,
          verdict: "wrong",
          correction: { present: true, value: "required" },
          intent: "apply",
        }),
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
      expect(operations.reviewBatch).toHaveBeenCalledWith({
        items: [
          expect.objectContaining({
            assessmentId: rowId,
            verdict: "correct",
            intent: "apply",
            correction: { present: false },
          }),
        ],
      }),
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
      await screen.findByRole("button", { name: "Accept" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(operations.review).toHaveBeenCalledWith(
        expect.objectContaining({
          assessmentId: rowId,
          verdict: "correct",
          intent: "apply",
          correction: { present: false },
        }),
      ),
    );
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
    expect(screen.getByText("Proposed")).toBeInTheDocument();
    harness.dispose();
  });

  it("renders an Addition ghost with the field's display label", async () => {
    const { harness } = setup([suggestion()]);
    expect(await screen.findByText("Food")).toBeInTheDocument();
    expect(screen.queryByText("CAT-2222")).not.toBeInTheDocument();
    harness.dispose();
  });

  it("bounds grouped-list suggestion requests before schema validation", async () => {
    const recordIds = Array.from({ length: 501 }, (_, index) =>
      testShortcode("product", `grouped-${index}`),
    );
    const read = vi.fn(
      async (
        input: Parameters<StoredSuggestionOperations["list"]>[0] & {
          limit: number;
        },
      ) => {
        fieldListInput(input);
        return {
          items: input.recordIds.map((recordId) => suggestion({ recordId })),
          next: null,
        };
      },
    );
    const rows = await everyPendingSuggestion(read)({
      entity: "product",
      recordIds,
      fields: ["categoryId"],
    });
    expect(rows.map((row) => row.recordId)).toEqual(recordIds);
  });

  // Seven suggestible Expense fields on a 250-row page exceed one read's
  // limit; a truncated read used to pass for the whole page.
  it("pages a list page's read to its last cursor so no read is truncated", async () => {
    const recordIds = Array.from({ length: 250 }, (_, index) =>
      testShortcode("expense", `page-${index}`),
    );
    const all = recordIds.flatMap((recordId) =>
      Array.from({ length: 7 }, (_, field) =>
        suggestion({ recordId, field: `field${field}` }),
      ),
    );
    const read = vi.fn(async (input: { cursor?: string; limit: number }) => {
      const offset = Number(input.cursor ?? 0);
      const end = offset + input.limit;
      return {
        items: all.slice(offset, end),
        next: end < all.length ? String(end) : null,
      };
    });
    const rows = await everyPendingSuggestion(read)({
      entity: "expense",
      recordIds,
      fields: [],
    });
    expect(rows).toHaveLength(1_750);
    expect(
      read.mock.calls.every(
        ([input]) => input.limit === SUGGESTION_LIST_PAGE_MAX,
      ),
    ).toBe(true);
  });

  // The read orders siblings strongest first; indexing kept the last, so the
  // weakest sibling's value was the one offered.
  it("offers the strongest of a field's sibling Suggestions", async () => {
    const { harness } = setup([
      suggestion({ confidence: 0.95 }),
      suggestion({
        id: "22222222-2222-4222-8222-222222222222",
        suggestedValue: "CAT-3333",
        confidence: 0.1,
      }),
    ]);
    expect(await screen.findByText("Food")).toBeInTheDocument();
    expect(screen.queryByText("CAT-3333")).not.toBeInTheDocument();
    harness.dispose();
  });

  it("renders a Correction as the current value followed by its ghost", async () => {
    const { harness } = setup(
      [
        suggestion({
          kind: "correction",
          currentValue: "CAT-AAAA",
          suggestedValue: "CAT-2222",
        }),
      ],
      undefined,
      productCategorySummary.parse({
        id: "CAT-AAAA",
        name: "Tools",
        feature: "tools",
        fields: {
          path: fieldValueFixture(
            productCategorySummary.shape.fields.shape.path,
            [{ id: "CAT-AAAA", name: "Tools" }],
          ),
        },
      }),
    );
    expect(await screen.findByText("Current category")).toBeInTheDocument();
    expect(await screen.findByText("Food")).toBeInTheDocument();
    expect(screen.getByLabelText("Suggested replacement")).toBeInTheDocument();
    harness.dispose();
  });

  it("accepts the stored Suggestion when its ghost is clicked", async () => {
    const { harness, operations } = setup([suggestion()]);
    fireEvent.click(
      await screen.findByRole("button", {
        name: /^Accept suggested value/,
      }),
    );
    await waitFor(() =>
      expect(operations.review).toHaveBeenCalledWith(
        expect.objectContaining({
          assessmentId: rowId,
          verdict: "correct",
          intent: "apply",
        }),
      ),
    );
    harness.dispose();
  });

  it("records Reject as a Miss from the ghost menu", async () => {
    const { harness, operations } = setup([suggestion()]);
    fireEvent.click(
      await screen.findByRole("button", { name: /suggestion actions/i }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    await waitFor(() =>
      expect(operations.review).toHaveBeenCalledWith(
        expect.objectContaining({
          assessmentId: rowId,
          verdict: "wrong",
          intent: "history",
        }),
      ),
    );
    harness.dispose();
  });

  it("accepts every pending Suggestion on the selected rows", async () => {
    const second = suggestion({
      id: "44444444-4444-4444-8444-444444444444",
      field: "brandName",
      suggestedValue: "Synthetic maker",
    });
    const { harness, operations } = setup([suggestion(), second]);
    fireEvent.click(
      await screen.findByRole("button", { name: /accept suggestions/i }),
    );
    // One batch call, not a sequential loop of single reviews.
    await waitFor(() =>
      expect(operations.reviewBatch).toHaveBeenCalledExactlyOnceWith({
        items: expect.arrayContaining([
          expect.objectContaining({
            assessmentId: rowId,
            verdict: "correct",
            intent: "apply",
          }),
          expect.objectContaining({
            assessmentId: second.id,
            verdict: "correct",
            intent: "apply",
          }),
        ]),
      }),
    );
    expect(operations.review).not.toHaveBeenCalled();
    harness.dispose();
  });
});
