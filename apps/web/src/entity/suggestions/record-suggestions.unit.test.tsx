import type {
  FieldSuggestionsInput,
  FieldSuggestionsOut,
} from "@cubby/schemas/ai";
import type {
  SettledSuggestionAnswer,
  SettledSuggestionQuestion,
} from "@cubby/schemas/ai";
import { suggestionReviewRowSchema } from "@cubby/schemas/ai";
import { productOut as productTopLevelOut } from "@cubby/schemas/entities/product";
import { testShortcode } from "@cubby/schemas/testing";
import { parseShortcode } from "@cubby/shared";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useContext } from "react";
import { renderToString } from "react-dom/server";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createEditorBrowserTestHarness as createBrowserTestHarness } from "#web/tests/editor-metadata.fixtures.ts";
import { createEntityMutationPort } from "~/entity/editing/use-entity-commands";
import { entityPreviewQueryOptions } from "~/entity/entity-query";
import { ensureEntityMetadata, entityMetadata } from "~/entity/metadata";
import { installFeatures } from "~/features/registry";
import { rippleFor } from "~/integrations/tanstack-query/cache-tags";
import { ai } from "~/integrations/tanstack-query/generated/domains/ai.gen";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { mock } from "~/lib/test/mock-schema";
import type { EntityBrowserMutationInput } from "~/server/entity-kernel/contracts";

import {
  fieldSuggestionBasisFromRecord,
  suggestionRecordFieldValue,
  type EntitySuggestionsOperations,
} from "./field-suggestion";
import { FieldSuggestionApply } from "./field-suggestion-apply";
import {
  RecordSuggestionsProvider,
  RecordFieldSuggestion,
  RecordSuggestionBoundary,
  RecordSuggestionsBulkAction,
  RecordSuggestionScope,
  type StoredSuggestionOperations,
} from "./record-suggestions";
import { suggestTargetsFor } from "./suggestion-targets";

function fixtureField(value: unknown, computed = false) {
  return {
    current: {
      assignment: computed
        ? null
        : value === null
          ? { kind: "inherit" }
          : { kind: "value", value, ownership: { kind: "record" } },
      controls: computed
        ? { kind: "readonly", reason: "computed" }
        : {
            kind: "editable",
            canSetNone: true,
            canConfirm: false,
            reset: { kind: "unavailable" },
          },
    },
    result: {
      kind: "live",
      decision: {
        outcome:
          value === null
            ? { kind: "empty", reason: "unset" }
            : { kind: "value", value },
        provenance: null,
      },
    },
    work: { kind: "idle" },
  };
}

function fixtureRecord<T extends { id: string }>(input: T) {
  const entity = parseShortcode(input.id)?.type;
  if (!entity) throw new Error("Synthetic record identity missing");
  const row = z.looseObject({ id: z.string() }).parse(input);
  const fields = z.record(z.string(), z.unknown()).parse(row.fields ?? {});
  const metadata = entityMetadata(harness.queryClient, entity);
  for (const key of metadata.envelopeFields) {
    const field = entityMetadata(
      harness.queryClient,
      entity,
    ).fields.fields.find(
      (candidate) => (candidate.readKey ?? candidate.key) === key,
    );
    const nestedKey = field?.key.replace(/Ids?$/u, "");
    let present = Object.hasOwn(row, key);
    let value = row[key];
    if (
      !present &&
      field?.reference &&
      nestedKey &&
      Object.hasOwn(row, nestedKey)
    ) {
      const nested = z
        .object({ id: z.string() })
        .nullable()
        .safeParse(row[nestedKey]);
      if (nested.success) {
        present = true;
        value = nested.data?.id ?? null;
      }
    }
    if (present && !Object.hasOwn(fields, key))
      fields[key] = fixtureField(
        value,
        !field ||
          !(
            metadata.fields.create.some((key) => key === field.key) ||
            metadata.fields.update.some((key) => key === field.key)
          ),
      );
  }
  const canonical = { ...input, fields };
  for (const key of metadata.envelopeFields)
    Reflect.deleteProperty(canonical, key);
  return canonical;
}

installFeatures();

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});

it("links live detail proposals and alternatives through the canonical field renderer", async () => {
  const record = fixtureRecord({
    id: testShortcode("task", "proposal"),
    name: "Synthetic task",
    projectId: null,
  });
  const proposedId = testShortcode("project", "proposed");
  const alternativeId = testShortcode("project", "alternative");
  for (const { projectId, name } of [
    { projectId: proposedId, name: "Synthetic proposed project" },
    { projectId: alternativeId, name: "Synthetic alternative project" },
  ]) {
    harness.queryClient.setQueryDefaults(
      entityPreviewQueryOptions("project", projectId).queryKey,
      { staleTime: Infinity },
    );
    harness.queryClient.setQueryData(
      entityPreviewQueryOptions("project", projectId).queryKey,
      { id: projectId, name },
    );
  }
  render(
    <RecordSuggestionsProvider
      entity="task"
      records={[record]}
      fieldKeys={["projectId"]}
      storedSuggestionOperations={emptyStoredSuggestionOperations}
      operations={{
        suggestFields: ai.suggestFields.withTransport(async () => ({
          suggestions: {
            projectId: {
              value: proposedId,
              label: "Synthetic proposed project",
              confidence: "high",
              probability: 0.97,
              detail: null,
              reasoning: "",
              operation: "set",
              removals: [],
              alternatives: [
                {
                  value: alternativeId,
                  label: "Synthetic alternative project",
                  detail: null,
                  probability: 0.03,
                },
              ],
            },
          },
          outcomes: {},
        })),
      }}
    >
      <RecordFieldSuggestion record={record} field="projectId">
        Not recorded
      </RecordFieldSuggestion>
    </RecordSuggestionsProvider>,
    { wrapper: harness.wrapper },
  );
  expect(
    await screen.findByRole("link", { name: "Synthetic proposed project" }),
  ).toHaveAttribute("href", `/projects/${proposedId}`);
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  expect(
    await screen.findByRole("link", { name: "Synthetic alternative project" }),
  ).toHaveAttribute("href", `/projects/${alternativeId}`);
});
afterEach(() => {
  harness.dispose();
});
const id = testShortcode("product", "first");
const emptyStoredSuggestionOperations: StoredSuggestionOperations = {
  list: async () => [],
  review: async ({ assessmentId, intent }) => ({
    assessmentId,
    feedbackId: crypto.randomUUID(),
    status: "recorded",
    applied: intent === "apply",
  }),
  reviewBatch: async () => [],
  settled: async ({ questions }) => ({
    results: questions.map(() => ({
      ok: true as const,
      value: { outcome: null, revision: null },
    })),
  }),
};
const decline = {
  kind: "evaluated" as const,
  answer: "none" as const,
  confidence: "high" as const,
  probability: 0.9,
  alternatives: [],
};
/** A settled port answering each question from `answer`, positionally. */
const settledBy = (
  answer: (question: SettledSuggestionQuestion) => SettledSuggestionAnswer,
) =>
  vi.fn<StoredSuggestionOperations["settled"]>(async ({ questions }) => ({
    results: questions.map((question) => ({
      ok: true as const,
      value: answer(question),
    })),
  }));
const food = {
  assessmentId: "00000000-0000-4000-8000-000000000001",
  value: "CAT-2222",
  label: "Food",
  confidence: "high" as const,
  probability: 0.97,
  detail: null,
  reasoning: "",
  alternatives: [],
  operation: "set" as const,
  removals: [],
};

function Surface({
  name,
  operations,
  visible = true,
}: {
  name: string;
  operations: EntitySuggestionsOperations;
  visible?: boolean;
}) {
  const record = fixtureRecord({ id, name, brandName: null, categoryId: null });
  return (
    <RecordSuggestionsProvider
      entity="product"
      records={visible ? [record] : []}
      fieldKeys={["categoryId"]}
      operations={operations}

      storedSuggestionOperations={emptyStoredSuggestionOperations}
    >
      {visible ? (
        <RecordFieldSuggestion record={record} field="categoryId">
          <span>Empty category</span>
          <FieldSuggestionApply
            source={{
              entity: "product",
              basisMode: "provided",
              targets: ["categoryId"],
              basis: { name, brandName: null },
            }}
            currentValue={null}
            onApply={() => {}}
            operations={operations}
          />
        </RecordFieldSuggestion>
      ) : null}
    </RecordSuggestionsProvider>
  );
}

describe("record suggestions", () => {
  // A virtualized list's loaded records are not all active. Mounting the
  // next row must ask it in a domain batch without re-asking a warm sibling.
  it("batches only mounted rows and retains each field's cache on scrolling", async () => {
    const records = ["first", "second", "offscreen"].map((name) =>
      fixtureRecord({
        id: testShortcode("product", name),
        name,
        brandName: null,
        categoryId: null,
      }),
    );
    const single = vi.fn(async () => ({ suggestions: {}, outcomes: {} }));
    const batches: FieldSuggestionsInput[][] = [];
    const operations: EntitySuggestionsOperations = {
      suggestFields: ai.suggestFields.withTransport(single),
      suggestFieldsBatch: ai.suggestFieldsBatch.withTransport(
        async ({ input }) => {
          batches.push(input.items);
          return {
            results: input.items.map(() => ({
              ok: true as const,
              value: { suggestions: {}, outcomes: { categoryId: decline } },
            })),
          };
        },
      ),
    };
    const List = ({ count }: { count: number }) => (
      <RecordSuggestionsProvider
        entity="product"
        records={records}
        viewportOnly
        fieldKeys={["categoryId"]}
        operations={operations}
        storedSuggestionOperations={emptyStoredSuggestionOperations}
      >
        {records.slice(0, count).map((record) => (
          <RecordSuggestionBoundary key={record.id} record={record}>
            <RecordFieldSuggestion record={record} field="categoryId">
              <span>{record.name}</span>
            </RecordFieldSuggestion>
          </RecordSuggestionBoundary>
        ))}
      </RecordSuggestionsProvider>
    );
    const view = render(<List count={2} />, { wrapper: harness.wrapper });
    await waitFor(() => expect(batches.flat()).toHaveLength(2));
    expect(single).not.toHaveBeenCalled();
    expect(batches).toHaveLength(1);
    view.rerender(<List count={3} />);
    await waitFor(() => expect(batches.flat()).toHaveLength(3));
    expect(batches.flat().map((input) => input.entityId)).toEqual(
      records.map((record) => record.id),
    );
  });

  it("explains an empty cell skipped for insufficient basis without asking", async () => {
    const asked = vi.fn();
    const operations: EntitySuggestionsOperations = {
      suggestFields: ai.suggestFields.withTransport(async () => {
        asked();
        return { suggestions: {}, outcomes: {} };
      }),
    };
    const record = fixtureRecord({
      id,
      name: "",
      brandName: null,
      model: null,
      notes: null,
      classificationEvidence: null,
      categoryId: null,
    });
    render(
      <RecordSuggestionsProvider
        entity="product"
        records={[record]}
        fieldKeys={["categoryId"]}
        operations={operations}
        storedSuggestionOperations={emptyStoredSuggestionOperations}
      >
        <RecordFieldSuggestion
          record={record}
          field="categoryId"
          surface="cell"
        >
          Empty category
        </RecordFieldSuggestion>
      </RecordSuggestionsProvider>,
      { wrapper: harness.wrapper },
    );
    expect(
      await screen.findByRole("button", {
        name: /Not checked.*add a name first/,
      }),
    ).toHaveTextContent("Not checked — add a name first");

    expect(asked).not.toHaveBeenCalled();
  });

  it.each([
    { field: "categoryId", readKey: "categoryId", proposal: food },
    {
      field: "ingredientId",
      readKey: "ingredient",
      proposal: {
        ...food,
        value: testShortcode("ingredient", "synthetic-fill"),
        label: "Synthetic ingredient",
      },
    },
  ])(
    "waits for deferred $field and preserves its explicit empty projection",
    async ({ field, readKey, proposal }) => {
      let finishStored!: (rows: []) => void;
      const stored = {
        ...emptyStoredSuggestionOperations,
        list: vi.fn(
          () =>
            new Promise<[]>((resolve) => {
              finishStored = resolve;
            }),
        ),
      };
      const operations = {
        suggestFields: ai.suggestFields.withTransport(async () => ({
          suggestions: { [field]: proposal },
          outcomes: {
            [field]: {
              kind: "evaluated",
              answer: "pick",
              confidence: "high",
              probability: food.probability,
              alternatives: [],
            },
          },
        })),
      };
      function Cell({ loaded }: { loaded: boolean }) {
        const base = fixtureRecord({ id, name: "Synthetic product" });
        const record = loaded
          ? fixtureRecord({ ...base, [readKey]: null })
          : base;
        return (
          <RecordSuggestionsProvider
            entity="product"
            records={[record]}
            fieldKeys={[field]}
            operations={operations}
            storedSuggestionOperations={stored}
          >
            <RecordFieldSuggestion
              record={record}
              field={field}
              surface="cell"
              renderValue={() => <span>Food</span>}
            >
              <span>Current category</span>
            </RecordFieldSuggestion>
          </RecordSuggestionsProvider>
        );
      }
      const view = render(<Cell loaded={false} />, {
        wrapper: harness.wrapper,
      });
      await waitFor(() => expect(stored.list).toHaveBeenCalled());
      await act(async () => finishStored([]));
      // Query notifications cross a task boundary before starting live reads.
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      expect(
        screen.queryByRole("button", { name: /^Accept suggested value/ }),
      ).toBeNull();
      view.rerender(<Cell loaded />);
      expect(
        await screen.findByRole("button", { name: /^Accept suggested value/ }),
      ).toBeVisible();
    },
  );

  it("loads hidden suggest fields for bulk acceptance and skips live queries for stored pairs", async () => {
    const recordId = "11111111-1111-4111-8111-111111111111";
    const storedRow = suggestionReviewRowSchema.parse({
      assessmentId: "00000000-0000-4000-8000-000000000001",
      id: "22222222-2222-4222-8222-222222222222",
      runId: "RUN-3333",
      entity: "product",
      recordId: id,
      field: "categoryId",
      currentValue: null,
      suggestedValue: "CAT-2222",
      confidence: 0.97,
      model: "typesafe/jev",
      kind: "addition",
      status: "pending",
      runnerUpValue: null,
      runnerUpConfidence: null,
      correctValue: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    let finishStored!: (
      rows: Awaited<ReturnType<StoredSuggestionOperations["list"]>>,
    ) => void;
    const stored: StoredSuggestionOperations = {
      list: vi.fn(
        async (input: Parameters<StoredSuggestionOperations["list"]>[0]) => {
          expect(input.fields).toContain("categoryId");
          return new Promise<
            Awaited<ReturnType<StoredSuggestionOperations["list"]>>
          >((resolve) => {
            finishStored = resolve;
          });
        },
      ),
      review: vi.fn(async ({ assessmentId, intent }) => ({
        assessmentId,
        feedbackId: "55555555-5555-4555-8555-555555555555",
        status: "recorded",
        applied: intent === "apply",
      })),
      reviewBatch: vi.fn(
        async ({
          items,
        }: Parameters<StoredSuggestionOperations["reviewBatch"]>[0]) =>
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
    };
    const suggestFields = vi.fn((_input: FieldSuggestionsInput) => undefined);
    const operations: EntitySuggestionsOperations = {
      suggestFields: ai.suggestFields.withTransport(async ({ input }) => {
        suggestFields(input);
        return { suggestions: {}, outcomes: {} };
      }),
    };
    render(
      <RecordSuggestionsProvider
        entity="product"
        records={[
          fixtureRecord({
            id,
            uuid: recordId,
            name: "Synthetic row",
            categoryId: null,
          }),
        ]}
        fieldKeys={["name"]}
        operations={operations}
        storedSuggestionOperations={stored}
      >
        <RecordSuggestionsBulkAction
          records={[
            fixtureRecord({
              id,
              uuid: recordId,
              name: "Synthetic row",
              categoryId: null,
            }),
          ]}
        />
        <RecordFieldSuggestion
          record={fixtureRecord({
            id,
            name: "Synthetic row",
            categoryId: null,
          })}
          field="categoryId"
        >
          <span>Current value</span>
        </RecordFieldSuggestion>
      </RecordSuggestionsProvider>,
      { wrapper: harness.wrapper },
    );
    await waitFor(() => expect(stored.list).toHaveBeenCalled());
    expect(suggestFields).not.toHaveBeenCalled();
    finishStored([storedRow]);
    expect(await screen.findByRole("button", { name: "Accept" })).toBeVisible();
    const review = screen.getByRole("button", { name: "Review" });
    expect(
      screen.queryByRole("button", { name: "Suggestion actions" }),
    ).toBeNull();
    fireEvent.click(review);
    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog")).getByText(/Confidence:/),
      ).toBeVisible(),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Accept suggestions (1)" }),
    );
    await waitFor(() =>
      expect(stored.reviewBatch).toHaveBeenCalledWith({
        items: [
          expect.objectContaining({
            assessmentId: "00000000-0000-4000-8000-000000000001",
            verdict: "correct",
            intent: "apply",
            correction: { present: false },
          }),
        ],
      }),
    );
    expect(suggestFields).not.toHaveBeenCalled();
  });

  // Regression: a fresh page-mount runKey in the query key re-asked every row
  // on each remount, defeating the stable cache profile.
  it("reuses the answer when the list remounts with a new runKey", async () => {
    const asked = vi.fn();
    const operations: EntitySuggestionsOperations = {
      suggestFields: ai.suggestFields.withTransport(async ({ input }) => {
        asked(input);
        return { suggestions: { categoryId: null }, outcomes: {} };
      }),
    };
    const record = fixtureRecord({
      id,
      name: "Synthetic oats",
      brandName: null,
      categoryId: null,
    });
    const List = () => (
      <RecordSuggestionsProvider
        entity="product"
        records={[record]}
        fieldKeys={["categoryId"]}
        operations={operations}
        storedSuggestionOperations={emptyStoredSuggestionOperations}
      >
        <span>rows</span>
      </RecordSuggestionsProvider>
    );
    const first = render(<List />, { wrapper: harness.wrapper });
    await waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    first.unmount();
    render(<List />, { wrapper: harness.wrapper });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
    expect(asked).toHaveBeenCalledTimes(1);
    expect(asked.mock.calls[0]?.[0]).toHaveProperty("runKey");
    // Saved record questions must reach canonical automation for every entity.
    expect(asked.mock.calls[0]?.[0]).toMatchObject({
      entityId: id,
      savedRecord: true,
    });
  });

  it("skips a remembered decline until its basis changes", async () => {
    const asked = vi.fn();
    const operations: EntitySuggestionsOperations = {
      suggestFields: ai.suggestFields.withTransport(async ({ input }) => {
        asked(input.basis.name);
        return { suggestions: { categoryId: null }, outcomes: {} };
      }),
    };
    const settled = settledBy((question) => ({
      outcome: question.basis.name === "Synthetic gadget" ? decline : null,
      revision: null,
    }));
    const stored = { ...emptyStoredSuggestionOperations, settled };
    const List = ({ name }: { name: string }) => (
      <RecordSuggestionsProvider
        entity="product"
        records={[
          fixtureRecord({ id, name, brandName: null, categoryId: null }),
        ]}
        fieldKeys={["categoryId"]}
        operations={operations}
        storedSuggestionOperations={stored}
      >
        <span>rows</span>
      </RecordSuggestionsProvider>
    );
    const view = render(<List name="Synthetic gadget" />, {
      wrapper: harness.wrapper,
    });
    await waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
    expect(asked).not.toHaveBeenCalled();

    view.rerender(<List name="Synthetic gadget, renamed" />);
    await waitFor(() =>
      expect(asked).toHaveBeenCalledExactlyOnceWith(
        "Synthetic gadget, renamed",
      ),
    );
    expect(settled).toHaveBeenCalledTimes(2);
  });

  // Regression: a component-local memory kept suppressing a decline after a
  // member review reopened it.
  it("re-asks a remembered decline after a review invalidates it", async () => {
    const asked = vi.fn();
    const operations: EntitySuggestionsOperations = {
      suggestFields: ai.suggestFields.withTransport(async ({ input }) => {
        asked(input.basis.name);
        return { suggestions: { categoryId: null }, outcomes: {} };
      }),
    };
    let remembered = true;
    const settled = settledBy(() => ({
      outcome: remembered ? decline : null,
      revision: null,
    }));
    render(
      <RecordSuggestionsProvider
        entity="product"
        records={[
          fixtureRecord({
            id,
            name: "Synthetic gadget",
            brandName: null,
            categoryId: null,
          }),
        ]}
        fieldKeys={["categoryId"]}
        operations={operations}
        storedSuggestionOperations={{
          ...emptyStoredSuggestionOperations,
          settled,
        }}
      >
        <span>rows</span>
      </RecordSuggestionsProvider>,
      { wrapper: harness.wrapper },
    );
    await waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
    expect(asked).not.toHaveBeenCalled();

    remembered = false;
    await act(() =>
      invalidateOperationTags(
        harness.queryClient,
        rippleFor(["settledSuggestions"]),
      ),
    );
    await waitFor(() =>
      expect(asked).toHaveBeenCalledExactlyOnceWith("Synthetic gadget"),
    );
  });

  // Regression: a reopened question restored the cached live `none` for its
  // old inputs, because the live query key was the basis alone. A member's
  // miss reopens under that review's revision rather than the original key.
  it.each([
    {
      trigger: "product write",
      ripple: "product",
      revision: "synthetic-inputs",
    },
    {
      trigger: "member miss",
      ripple: "settledSuggestions",
      revision: "miss:synthetic-feedback",
    },
  ] as const)(
    "asks a question reopened by a $trigger live",
    async ({ ripple, revision }) => {
      const asked = vi.fn();
      const operations: EntitySuggestionsOperations = {
        suggestFields: ai.suggestFields.withTransport(async ({ input }) => {
          asked(input.inputRevision ?? null);
          return {
            suggestions: { categoryId: null },
            outcomes: { categoryId: decline },
          };
        }),
      };
      // Production never refetches a passive cache entry on remount.
      harness.queryClient.setDefaultOptions({
        queries: { retry: false, refetchOnMount: false },
      });
      let answer: SettledSuggestionAnswer = { outcome: null, revision: null };
      const settled = settledBy(() => answer);
      render(
        <RecordSuggestionsProvider
          entity="product"
          records={[
            fixtureRecord({
              id,
              name: "Synthetic gadget",
              brandName: null,
              categoryId: null,
            }),
          ]}
          fieldKeys={["categoryId"]}
          operations={operations}
          storedSuggestionOperations={{
            ...emptyStoredSuggestionOperations,
            settled,
          }}
        >
          <span>rows</span>
        </RecordSuggestionsProvider>,
        { wrapper: harness.wrapper },
      );
      await waitFor(() => expect(asked).toHaveBeenCalledExactlyOnceWith(null));

      // The decline is remembered, then the trigger reopens it.
      const invalidate = () =>
        act(() =>
          invalidateOperationTags(harness.queryClient, rippleFor([ripple])),
        );
      answer = { outcome: decline, revision: null };
      await invalidate();
      await waitFor(() => expect(settled).toHaveBeenCalledTimes(2));
      answer = { outcome: null, revision };
      await invalidate();
      await waitFor(() => expect(asked).toHaveBeenLastCalledWith(revision));
      expect(
        asked.mock.calls.filter(([asked]) => asked === revision),
      ).toHaveLength(1);
    },
  );

  // Regression: each settled question was its own unscheduled read, so a page
  // of rows fanned out past the database limiter.
  it("reads a page's settled questions in one batched dispatch", async () => {
    const settled = settledBy(() => ({ outcome: decline, revision: null }));
    const records = Array.from({ length: 12 }, (_, index) =>
      fixtureRecord({
        id: testShortcode("product", `batch${index}`),
        name: `Synthetic batch row ${index}`,
        brandName: null,
        categoryId: null,
      }),
    );
    render(
      <RecordSuggestionsProvider
        entity="product"
        records={records}
        fieldKeys={["categoryId"]}
        operations={{
          suggestFields: ai.suggestFields.withTransport(async () => {
            throw new Error("Settled rows must not be asked live");
          }),
        }}
        storedSuggestionOperations={{
          ...emptyStoredSuggestionOperations,
          settled,
        }}
      >
        <span>rows</span>
      </RecordSuggestionsProvider>,
      { wrapper: harness.wrapper },
    );
    await waitFor(() => expect(settled).toHaveBeenCalledTimes(1));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    await waitFor(() => expect(harness.queryClient.isFetching()).toBe(0));
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled.mock.calls[0]?.[0].questions).toHaveLength(12);
  });

  // Regression: deriving a basis and a query observer per row during SSR cost
  // list pages hundreds of ms of Worker CPU; suggestions only resolve in the
  // browser, so the server render must not create any.
  it("creates no suggestion queries while rendering on the server", async () => {
    await ensureEntityMetadata(harness.queryClient, "product");
    const cachedQueries = harness.queryClient.getQueryCache().getAll();
    const suggestFields = vi.fn();
    const operations: EntitySuggestionsOperations = {
      suggestFields: ai.suggestFields.withTransport(async ({ input }) => {
        suggestFields(input);
        return { suggestions: {}, outcomes: {} };
      }),
    };
    const records = Array.from({ length: 20 }, (_, index) =>
      fixtureRecord({
        id: testShortcode("product", `row${index}`),
        name: `Synthetic row ${index}`,
        brandName: null,
        categoryId: null,
      }),
    );
    const Wrapper = harness.wrapper;
    const html = renderToString(
      <Wrapper>
        <RecordSuggestionsProvider
          entity="product"
          records={records}
          fieldKeys={["categoryId"]}
          operations={operations}

          storedSuggestionOperations={emptyStoredSuggestionOperations}
        >
          <span>rows</span>
        </RecordSuggestionsProvider>
      </Wrapper>,
    );
    expect(harness.queryClient.getQueryCache().getAll()).toEqual(cachedQueries);
    expect(suggestFields).not.toHaveBeenCalled();
    // The status line is already in place, so hydration does not shift the
    // table below it.
    expect(html).toContain("Checking suggestions…");
  });

  it("does not display an old result for changed inputs, reuses the cell result, and dismisses within a visit", async () => {
    const calls: FieldSuggestionsInput[] = [];
    let finish!: (result: FieldSuggestionsOut) => void;
    const operations: EntitySuggestionsOperations = {
      suggestFields: ai.suggestFields.withTransport(async ({ input }) => {
        calls.push(input);
        if (input.basis.name === "steel wrench")
          return new Promise((resolve) => {
            finish = resolve;
          });
        return {
          suggestions: { categoryId: food },
          outcomes: {
            categoryId: {
              kind: "evaluated" as const,
              answer: "pick" as const,
              confidence: "high" as const,
              probability: food.probability,
              alternatives: [],
            },
          },
        };
      }),
    };
    const view = render(<Surface name="red apple" operations={operations} />, {
      wrapper: harness.wrapper,
    });
    await screen.findByText("Food");
    expect(calls).toHaveLength(2);
    expect(calls.some((call) => call.basisMode === "suggested")).toBe(true);
    view.rerender(<Surface name="steel wrench" operations={operations} />);
    expect(screen.queryByText("Food")).not.toBeInTheDocument();
    await waitFor(() => expect(calls).toHaveLength(3));
    await act(async () => {
      finish({
        suggestions: {
          categoryId: { ...food, value: "CAT-2224", label: "Tools" },
        },
        outcomes: {
          categoryId: {
            kind: "evaluated",
            answer: "pick",
            confidence: "high",
            probability: food.probability,
            alternatives: [],
          },
        },
      });
    });
    await screen.findByText("Tools");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    view.rerender(
      <Surface name="steel wrench" operations={operations} visible={false} />,
    );
    view.rerender(<Surface name="steel wrench" operations={operations} />);
    expect(screen.queryByText("Tools")).not.toBeInTheDocument();
    expect(
      screen.getByText("No suggestions · 1 field checked"),
    ).toBeInTheDocument();
    expect(calls).toHaveLength(3);
  });

  // Failure modes: a saved list revisit shows only the pending glyph until the
  // slow live check returns; a cached preview can be accepted, rejected or
  // corrected before the live answer validates it; a live failure is masked by
  // the cached answer instead of shown raw.
  describe("saved-record previews", () => {
    const pick = (probability: number) => ({
      kind: "evaluated" as const,
      answer: "pick" as const,
      confidence: "high" as const,
      probability,
      assessmentId: food.assessmentId,
      alternatives: [],
    });
    const previewing = (probability: number) =>
      vi.fn<NonNullable<StoredSuggestionOperations["previews"]>>(
        async ({ questions }) => ({
          results: questions.map((question) => ({
            ok: true as const,
            value: {
              outcome: null,
              revision: null,
              preview:
                question.entityId === id
                  ? {
                      suggestion: {
                        ...food,
                        probability,
                        reasoning: "Synthetic cached evidence",
                      },
                      outcome: pick(probability),
                    }
                  : null,
            },
          })),
        }),
      );
    const deferredLive = () => {
      let resolveLive = (_out: FieldSuggestionsOut) => {};
      let rejectLive = (_error: Error) => {};
      const answer = new Promise<FieldSuggestionsOut>((resolve, reject) => {
        resolveLive = resolve;
        rejectLive = reject;
      });
      const operations: EntitySuggestionsOperations = {
        suggestFields: ai.suggestFields.withTransport(async () => answer),
      };
      return {
        live: {
          resolve: (out: FieldSuggestionsOut) => resolveLive(out),
          reject: (error: Error) => rejectLive(error),
        },
        operations,
      };
    };
    const Cell = ({
      operations,
      previews,
      settled = emptyStoredSuggestionOperations.settled,
      surface = "cell",
    }: {
      operations: EntitySuggestionsOperations;
      previews: StoredSuggestionOperations["previews"];
      settled?: StoredSuggestionOperations["settled"];
      surface?: "cell" | "inline";
    }) => {
      const record = fixtureRecord({
        id,
        name: "Synthetic cached gadget",
        brandName: null,
        categoryId: null,
      });
      return (
        <RecordSuggestionsProvider
          entity="product"
          records={[record]}
          fieldKeys={["categoryId"]}
          operations={operations}
          storedSuggestionOperations={{
            ...emptyStoredSuggestionOperations,
            settled,
            previews,
          }}
        >
          <RecordFieldSuggestion
            record={record}
            field="categoryId"
            surface={surface}
          >
            <span>Empty category</span>
          </RecordFieldSuggestion>
        </RecordSuggestionsProvider>
      );
    };

    it("shows a cached strong answer while the live check runs and blocks it until current", async () => {
      const { live, operations } = deferredLive();
      const previews = previewing(0.97);
      render(<Cell operations={operations} previews={previews} />, {
        wrapper: harness.wrapper,
      });
      const accept = await screen.findByRole("button", {
        name: /^Accept suggested value/,
      });
      expect(accept).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Suggestion actions" }),
      ).toBeDisabled();
      expect(previews).toHaveBeenCalledOnce();

      await act(async () =>
        live.resolve({
          suggestions: { categoryId: food },
          outcomes: { categoryId: pick(0.97) },
        }),
      );
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: /^Accept suggested value/ }),
        ).toBeEnabled(),
      );
    });

    // Regression: previews were read only for live asks, so a row whose
    // verified settled read was still preparing showed only the pending glyph.
    it("shows a cached answer while the verified settled read is held", async () => {
      const { operations } = deferredLive();
      const settled = vi.fn<StoredSuggestionOperations["settled"]>(
        () => new Promise(() => {}),
      );
      render(
        <Cell
          operations={operations}
          previews={previewing(0.97)}
          settled={settled}
        />,
        { wrapper: harness.wrapper },
      );
      expect(
        await screen.findByRole("button", { name: /^Accept suggested value/ }),
      ).toBeDisabled();
      expect(settled).toHaveBeenCalledOnce();
    });

    it("keeps an inline cached review's actions disabled until current", async () => {
      const { live, operations } = deferredLive();
      render(
        <Cell
          operations={operations}
          previews={previewing(0.97)}
          surface="inline"
        />,
        { wrapper: harness.wrapper },
      );
      const accept = await screen.findByRole("button", { name: "Accept" });
      expect(accept).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Review" }));
      expect(
        await screen.findByRole("button", { name: "Reject" }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Use a different value…" }),
      ).toBeDisabled();
      await act(async () =>
        live.resolve({
          suggestions: { categoryId: food },
          outcomes: { categoryId: pick(0.97) },
        }),
      );
      await waitFor(() =>
        expect(
          within(screen.getByRole("dialog")).getByRole("button", {
            name: "Accept",
          }),
        ).toBeEnabled(),
      );
    });

    it("shows a cached weak answer instead of the pending glyph and a live failure raw", async () => {
      const { live, operations } = deferredLive();
      render(<Cell operations={operations} previews={previewing(0.4)} />, {
        wrapper: harness.wrapper,
      });
      const status = await screen.findByRole("button", {
        name: /Leaning Food/,
      });
      expect(status).toHaveTextContent("Below threshold");
      expect(
        screen.queryByRole("button", { name: "Checking suggestion…" }),
      ).toBeNull();
      fireEvent.click(status);
      expect(
        await screen.findByText("Synthetic cached evidence"),
      ).toBeVisible();
      for (const name of ["Accept", "Reject", "Use a different value…"])
        expect(
          screen.queryByRole("button", { name })?.hasAttribute("disabled") ??
            true,
        ).toBe(true);

      await act(async () =>
        live.reject(new Error("Synthetic SQLSTATE 57014 live check failed")),
      );
      expect(
        await screen.findByRole("button", {
          name: "Suggestion unavailable: Synthetic SQLSTATE 57014 live check failed",
        }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Leaning Food/ })).toBeNull();
    });
  });

  it("shows a confident live answer as a ghost pill and explains a weak empty-field answer", async () => {
    const answers = {
      "red apple": 0.97,
      "green pear": 0.97,
      "steel wrench": 0.4,
    };
    const operations: EntitySuggestionsOperations = {
      suggestFields: ai.suggestFields.withTransport(async ({ input }) => {
        const probability =
          answers[
            z
              .enum(["red apple", "green pear", "steel wrench"])
              .parse(input.basis.name)
          ];
        return {
          suggestions: {
            categoryId: {
              ...food,
              probability,
              reasoning: "Synthetic category evidence",
              alternatives: [
                {
                  value: "CAT-CCCC",
                  label: "Tools / Drivers",
                  detail: null,
                  probability: 0.3,
                },
              ],
            },
          },
          outcomes: {
            categoryId: {
              kind: "evaluated" as const,
              answer: "pick" as const,
              confidence: "high" as const,
              probability,
              alternatives: [],
            },
          },
        };
      }),
    };
    function Cell({ name }: { name: keyof typeof answers }) {
      const record = fixtureRecord({
        id,
        name,
        brandName: null,
        categoryId: null,
      });
      return (
        <RecordSuggestionsProvider
          entity="product"
          records={[record]}
          fieldKeys={["categoryId"]}
          operations={operations}
          storedSuggestionOperations={emptyStoredSuggestionOperations}
        >
          <RecordFieldSuggestion
            record={record}
            field="categoryId"
            surface="cell"
          >
            <span>Empty category</span>
            <ScopeProbe />
          </RecordFieldSuggestion>
        </RecordSuggestionsProvider>
      );
    }
    // A nested inline editor reads the row scope to reuse this row's answer.
    function ScopeProbe() {
      return useContext(RecordSuggestionScope) ? <span>row scoped</span> : null;
    }
    const view = render(<Cell name="red apple" />, {
      wrapper: harness.wrapper,
    });
    // The value is inert inside the button, so its text names the button.
    await screen.findByRole("button", {
      name: /^Accept suggested value: \S/,
    });
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Suggestion actions" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /^Accept suggested value/ }),
      ).toBeNull(),
    );
    expect(
      screen.queryByRole("button", { name: /^Accept suggested value/ }),
    ).toBeNull();

    // Keeping the current value through the editor still rejects the answer.
    view.rerender(<Cell name="green pear" />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Suggestion actions" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Use a different value…" }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /^Accept suggested value/ }),
      ).toBeNull(),
    );

    view.rerender(<Cell name="steel wrench" />);
    await screen.findByText("No suggestions · 1 field checked");
    expect(screen.getByText("row scoped")).toBeInTheDocument();
    const status = screen.getByRole("button", { name: /Leaning Food/ });
    expect(status).toHaveTextContent("Below threshold");
    expect(
      screen.queryByRole("button", { name: /^Accept suggested value/ }),
    ).toBeNull();
    // A weak proposal's evidence remains inspectable without an apply action.
    fireEvent.click(status);
    expect(
      await screen.findByText("Synthetic category evidence"),
    ).toBeVisible();
    expect(screen.getByText(/Tools \/ Drivers/)).toBeVisible();
  });

  it("opens the normal editor with the saved value after acceptance fails", async () => {
    const record = fixtureRecord({
      id: testShortcode("inventory", "bin"),
      product: { id: testShortcode("product", "bin"), name: "Storage bin" },
      location: { id: testShortcode("location", "old"), name: "Garage" },
    });
    const locationId = testShortcode("location", "new");
    const commands: EntityBrowserMutationInput[] = [];
    let calls = 0;
    const source = {
      entity: "inventory" as const,
      basisMode: "provided" as const,
      targets: ["locationId"],
      basis: { productId: record.product.id },
    };
    const operations: EntitySuggestionsOperations = {
      suggestFields: ai.suggestFields.withTransport(async () => {
        calls += 1;
        return {
          suggestions: {
            locationId: { ...food, value: locationId, label: "Workshop" },
          },
        };
      }),
    };
    render(
      <RecordSuggestionsProvider
        entity="inventory"
        records={[record]}
        fieldKeys={["location"]}
        operations={operations}
        readRecord={async () => record}
        mutationPort={createEntityMutationPort({
          execute: async (command) => {
            commands.push(command);
            if (commands.length === 1) throw new Error("unavailable");
            return {
              action: "update",
              entity: "inventory",
              item: {
                id: record.id,
                locationId,
              },
              appliedFields: [],
              sideEffects: {},
            };
          },
        })}

        storedSuggestionOperations={emptyStoredSuggestionOperations}
      >
        <RecordSuggestionBoundary record={record}>
          <RecordFieldSuggestion record={record} field="location">
            <span>Garage</span>
          </RecordFieldSuggestion>
          <FieldSuggestionApply
            source={source}
            currentValue={record.location.id}
            onApply={() => {}}
            operations={operations}
          />
        </RecordSuggestionBoundary>
      </RecordSuggestionsProvider>,
      { wrapper: harness.wrapper },
    );
    await screen.findByText("Workshop");
    expect(calls).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(
      await screen.findByRole("dialog", { name: "Edit Inventory Item" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Garage").length).toBeGreaterThan(0);
    expect(commands[0]).toEqual({
      action: "update",
      entity: "inventory",
      id: record.id,
      data: { locationId },
    });
    expect(commands).toHaveLength(1);
  });

  it("saves a removal after an unrelated tag addition, preserving the new tag", async () => {
    const record = fixtureRecord({
      id: testShortcode("product", "tag-remove"),
      name: "Rain shell",
      brandName: "Jacquemus",
      categoryId: null,
      tags: ["jacquemus", "ecosystem", "mount"],
    });
    const removeSuggestion = {
      assessmentId: "00000000-0000-4000-8000-000000000002",
      value: "jacquemus",
      label: "Remove jacquemus",
      confidence: "high" as const,
      probability: 0.9,
      detail: "restates brandName",
      reasoning: "",
      alternatives: [],
      operation: "remove" as const,
      removals: [
        {
          value: "jacquemus",
          probability: 0.9,
          reason: "restates brandName",
        },
      ],
    };
    const commands: EntityBrowserMutationInput[] = [];
    const operations: EntitySuggestionsOperations = {
      suggestFields: ai.suggestFields.withTransport(async () => ({
        suggestions: { tags: removeSuggestion },
      })),
    };
    const item = mock(productTopLevelOut, {
      seed: 1,
      overrides: {
        id: record.id,
        fields: {
          tags: {
            current: {
              assignment: {
                kind: "value",
                value: ["ecosystem", "mount"],
                ownership: { kind: "record" },
              },
            },
            result: {
              kind: "live",
              decision: {
                outcome: {
                  kind: "value",
                  value: ["ecosystem", "mount"],
                },
                provenance: { kind: "own", ownership: { kind: "record" } },
              },
            },
          },
        },
      },
    });
    render(
      <RecordSuggestionsProvider
        entity="product"
        records={[record]}
        fieldKeys={["tags"]}
        operations={operations}
        readRecord={async () =>
          fixtureRecord({
            ...record,
            fields: {
              ...record.fields,
              tags: fixtureField([
                "jacquemus",
                "ecosystem",
                "mount",
                "compatibility",
              ]),
            },
          })
        }
        mutationPort={createEntityMutationPort({
          execute: async (command) => {
            commands.push(command);
            return {
              action: "update",
              entity: "product",
              item: { id: item.id },
              appliedFields: [],
              sideEffects: {},
            };
          },
        })}

        storedSuggestionOperations={emptyStoredSuggestionOperations}
      >
        <RecordFieldSuggestion record={record} field="tags">
          <span>current tags</span>
        </RecordFieldSuggestion>
      </RecordSuggestionsProvider>,
      { wrapper: harness.wrapper },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    await waitFor(() => expect(commands).toHaveLength(1));
    expect(commands[0]).toEqual({
      action: "update",
      entity: "product",
      id: record.id,
      data: { tags: ["ecosystem", "mount", "compatibility"] },
    });
  });

  it("refuses a remove suggestion once its removal is no longer present", async () => {
    const record = fixtureRecord({
      id: testShortcode("product", "tag-stale"),
      name: "Rain shell",
      brandName: "Jacquemus",
      categoryId: null,
      tags: ["jacquemus", "mount"],
    });
    const removeSuggestion = {
      assessmentId: "00000000-0000-4000-8000-000000000003",
      value: "jacquemus",
      label: "Remove jacquemus",
      confidence: "high" as const,
      probability: 0.9,
      detail: "restates brandName",
      reasoning: "",
      alternatives: [],
      operation: "remove" as const,
      removals: [
        {
          value: "jacquemus",
          probability: 0.9,
          reason: "restates brandName",
        },
      ],
    };
    const commands: EntityBrowserMutationInput[] = [];
    const operations: EntitySuggestionsOperations = {
      suggestFields: ai.suggestFields.withTransport(async () => ({
        suggestions: { tags: removeSuggestion },
      })),
    };
    render(
      <RecordSuggestionsProvider
        entity="product"
        records={[record]}
        fieldKeys={["tags"]}
        operations={operations}
        // The tag was removed by someone else between the suggestion and the
        // click — a sibling basis field (brandName) is unchanged, so only
        // the every-removal-still-present check catches this.
        readRecord={async () =>
          fixtureRecord({
            ...record,
            fields: { ...record.fields, tags: fixtureField(["mount"]) },
          })
        }
        mutationPort={createEntityMutationPort({
          execute: async (command) => {
            commands.push(command);
            throw new Error("must not write");
          },
        })}

        storedSuggestionOperations={emptyStoredSuggestionOperations}
      >
        <RecordFieldSuggestion record={record} field="tags">
          <span>current tags</span>
        </RecordFieldSuggestion>
      </RecordSuggestionsProvider>,
      { wrapper: harness.wrapper },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    await screen.findByRole("alert");
    expect(commands).toHaveLength(0);
  });

  it("reads inventory's nested product reference as the location suggestion basis", () => {
    const productId = testShortcode("product", "second");
    const basis = fieldSuggestionBasisFromRecord(
      harness.queryClient,
      "inventory",
      suggestTargetsFor(harness.queryClient, "inventory", ["locationId"]),
      {
        product: { id: productId, name: "Storage bin" },
        location: {
          id: testShortcode("location", "workshop"),
          name: "Workshop",
        },
      },
    );
    expect(basis).toEqual({
      productId,
      __referenceLabels: JSON.stringify({
        productId: { id: productId, name: "Storage bin" },
      }),
    });
  });

  it("changes the authoritative basis when reference evidence is renamed", () => {
    const productId = testShortcode("product", "renamed");
    const targets = suggestTargetsFor(harness.queryClient, "inventory", [
      "locationId",
    ]);
    const before = fieldSuggestionBasisFromRecord(
      harness.queryClient,
      "inventory",
      targets,
      {
        product: { id: productId, name: "Storage bin" },
      },
    );
    const after = fieldSuggestionBasisFromRecord(
      harness.queryClient,
      "inventory",
      targets,
      {
        product: { id: productId, name: "Garage tote" },
      },
    );

    expect(after.productId).toBe(before.productId);
    expect(after.__referenceLabels).not.toBe(before.__referenceLabels);
  });

  it("rechecks authoritative eligibility before accepting a rendered proposal", async () => {
    const record = fixtureRecord({
      id: testShortcode("task", "stale"),
      name: "Install a circuit breaker",
      trade: null,
    });
    let calls = 0;
    const commands: EntityBrowserMutationInput[] = [];
    const operations: EntitySuggestionsOperations = {
      suggestFields: ai.suggestFields.withTransport(async () => {
        calls += 1;
        return {
          suggestions: {
            trade: { ...food, value: "electrical", label: "Electrical" },
          },
          eligibleTargets: ["trade"],
        };
      }),
    };
    render(
      <RecordSuggestionsProvider
        entity="task"
        records={[record]}
        fieldKeys={["trade"]}
        operations={operations}
        readRecord={async () => ({
          ...record,
          fields: {
            trade: {
              current: {
                assignment: { kind: "inherit" },
                controls: {
                  kind: "editable",
                  canSetNone: true,
                  canConfirm: true,
                  reset: { kind: "unavailable" },
                },
              },
              result: {
                kind: "live",
                decision: {
                  outcome: { kind: "value", value: "electrical" },
                  provenance: { kind: "default", source: null },
                },
              },
              work: { kind: "idle" },
            },
          },
        })}
        mutationPort={createEntityMutationPort({
          execute: async (command) => {
            commands.push(command);
            throw new Error("must not write");
          },
        })}

        storedSuggestionOperations={emptyStoredSuggestionOperations}
      >
        <RecordFieldSuggestion record={record} field="trade">
          <span>Empty trade</span>
        </RecordFieldSuggestion>
      </RecordSuggestionsProvider>,
      { wrapper: harness.wrapper },
    );

    const errorSpy = vi.spyOn(toast, "error").mockImplementation(() => "");
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Suggestion inputs changed");
    expect(calls).toBe(1);
    expect(commands).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it("accepts a proposal against its complete request basis (regression: 'Suggestion inputs changed')", async () => {
    // Acceptance must reproduce the request's own declared keys and
    // inheritance context, without widening it to other visible targets
    // or silently dropping a context key from its drift fingerprint.
    const record = fixtureRecord({
      id: testShortcode("expense", "regression"),
      name: "Lumber order",
      lineKind: "principal" as const,
      costType: "materials" as const,
      trade: "building" as const,
      vendor: "Home Depot",
      notes: null,
      projectId: null,
      productId: null,
      orderId: null,
      date: null,
    });
    let saved = false;
    const commands: EntityBrowserMutationInput[] = [];
    const calls: FieldSuggestionsInput[] = [];
    const operations: EntitySuggestionsOperations = {
      suggestFields: ai.suggestFields.withTransport(
        async ({ input }): Promise<FieldSuggestionsOut> => {
          calls.push(input);
          if (input.targets.includes("costType")) {
            return {
              suggestions: {
                costType: { ...food, value: "tools", label: "Tools" },
              },
            };
          }
          return { suggestions: {} };
        },
      ),
    };
    render(
      <RecordSuggestionsProvider
        entity="expense"
        records={[record]}
        fieldKeys={[
          "costType",
          "trade",
          "vendor",
          "notes",
          "projectId",
          "productId",
        ]}
        operations={operations}
        readRecord={async () =>
          saved
            ? fixtureRecord({
                ...record,
                fields: { ...record.fields, costType: fixtureField("tools") },
              })
            : record
        }
        mutationPort={createEntityMutationPort({
          execute: async (command) => {
            commands.push(command);
            saved = true;
            return {
              action: "update",
              entity: "expense",
              item: {
                id: record.id,
                costType: "tools",
              },
              appliedFields: [],
              sideEffects: {},
            };
          },
        })}

        storedSuggestionOperations={emptyStoredSuggestionOperations}
      >
        <RecordFieldSuggestion record={record} field="costType">
          <span>Materials</span>
        </RecordFieldSuggestion>
      </RecordSuggestionsProvider>,
      { wrapper: harness.wrapper },
    );
    await screen.findByText("Tools");
    expect(calls.length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(commands).toHaveLength(1));
    expect(commands[0]).toMatchObject({
      action: "update",
      entity: "expense",
      id: record.id,
      data: { costType: "tools" },
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("resets a redundant override when the proposal matches its inherited fallback", async () => {
    const record = fixtureRecord({
      id: testShortcode("task", "redundant"),
      name: "Replace electrical panel",
      trade: "plumbing",
      fields: {
        trade: {
          current: {
            assignment: {
              kind: "value",
              value: "plumbing",
              ownership: { kind: "record" },
            },
            controls: {
              kind: "editable",
              canSetNone: true,
              canConfirm: false,
              reset: {
                kind: "available",
                preview: {
                  kind: "ready",
                  result: {
                    kind: "live",
                    decision: {
                      outcome: { kind: "value", value: "electrical" },
                      provenance: null,
                    },
                  },
                },
              },
            },
          },
          result: {
            kind: "live",
            decision: {
              outcome: { kind: "value", value: "plumbing" },
              provenance: { kind: "own", ownership: { kind: "record" } },
            },
          },
          work: { kind: "idle" },
        },
      },
    });
    const commands: EntityBrowserMutationInput[] = [];
    const operations: EntitySuggestionsOperations = {
      suggestFields: ai.suggestFields.withTransport(async () => ({
        suggestions: {
          trade: { ...food, value: "electrical", label: "Electrical" },
        },
      })),
    };
    render(
      <RecordSuggestionsProvider
        entity="task"
        records={[record]}
        fieldKeys={["trade"]}
        operations={operations}
        readRecord={async () => record}
        mutationPort={createEntityMutationPort({
          execute: async (command) => {
            commands.push(command);
            throw new Error("stop after capture");
          },
        })}

        storedSuggestionOperations={emptyStoredSuggestionOperations}
      >
        <RecordFieldSuggestion record={record} field="trade">
          <span>Plumbing</span>
        </RecordFieldSuggestion>
      </RecordSuggestionsProvider>,
      { wrapper: harness.wrapper },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    expect(
      await screen.findByRole("dialog", { name: "Edit Task" }),
    ).toBeInTheDocument();
    expect(commands[0]).toMatchObject({
      action: "update",
      entity: "task",
      id: record.id,
      data: { trade: null },
    });
  });

  it("routes unresolved inheritance and explicit None to separate review batches", async () => {
    const calls: FieldSuggestionsInput[] = [];
    const operations: EntitySuggestionsOperations = {
      suggestFields: ai.suggestFields.withTransport(async ({ input }) => {
        calls.push(input);
        return { suggestions: {} };
      }),
    };
    const resolution = {
      current: {
        assignment: { kind: "inherit" },
        controls: {
          kind: "editable",
          canSetNone: true,
          canConfirm: false,
          reset: { kind: "unavailable" },
        },
      },
      result: {
        kind: "live",
        decision: {
          outcome: { kind: "empty", reason: "unset" },
          provenance: null,
        },
      },
      work: { kind: "idle" },
    };
    render(
      <RecordSuggestionsProvider
        entity="expense"
        records={[
          fixtureRecord({
            id: testShortcode("expense", "inherited"),
            name: "Permit fee",
            lineKind: "principal",
            projectId: null,
            trade: null,
            fields: {
              projectId: resolution,
              trade: {
                ...resolution,
                current: {
                  ...resolution.current,
                  assignment: { kind: "none" },
                },
                result: {
                  kind: "live",
                  decision: {
                    outcome: { kind: "empty", reason: "explicit_none" },
                    provenance: { kind: "own", ownership: { kind: "record" } },
                  },
                },
              },
            },
          }),
        ]}
        fieldKeys={["projectId", "trade"]}
        operations={operations}

        storedSuggestionOperations={emptyStoredSuggestionOperations}
      >
        <span>row</span>
      </RecordSuggestionsProvider>,
      { wrapper: harness.wrapper },
    );
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          basisMode: "suggested",
          targets: ["projectId"],
          basis: expect.objectContaining({
            __resolutionContext: expect.any(String),
          }),
        }),
        expect.objectContaining({
          basisMode: "provided",
          targets: ["trade"],
          basis: expect.objectContaining({
            __resolutionContext: expect.any(String),
          }),
        }),
      ]),
    );
  });

  it("merges outcomes across the suggested, provided, and prune request groups onto one row", async () => {
    // categoryId is empty → its own "suggested" group; tags already has
    // entries → its own "prune" group. Two separate requests, one row.
    const record = fixtureRecord({
      id: testShortcode("product", "merge-outcomes"),
      name: "Rain shell",
      brandName: "Jacquemus",
      categoryId: null,
      tags: ["jacquemus"],
    });
    const operations: EntitySuggestionsOperations = {
      suggestFields: ai.suggestFields.withTransport(
        async ({ input }): Promise<FieldSuggestionsOut> => {
          if (input.targets.includes("categoryId")) {
            return {
              suggestions: { categoryId: food },
              outcomes: {
                categoryId: {
                  kind: "evaluated",
                  answer: "pick",
                  confidence: "high",
                  probability: food.probability,
                  alternatives: [],
                },
              },
            };
          }
          return {
            suggestions: {},
            outcomes: {
              tags: {
                kind: "evaluated",
                answer: "none",
                confidence: "medium",
                probability: 0.6,
                alternatives: [],
              },
            },
          };
        },
      ),
    };
    render(
      <RecordSuggestionsProvider
        entity="product"
        records={[record]}
        fieldKeys={["categoryId", "tags"]}
        operations={operations}

        storedSuggestionOperations={emptyStoredSuggestionOperations}
      >
        <RecordFieldSuggestion record={record} field="categoryId">
          <span>Empty category</span>
        </RecordFieldSuggestion>
        <RecordFieldSuggestion record={record} field="tags">
          <span>current tags</span>
        </RecordFieldSuggestion>
      </RecordSuggestionsProvider>,
      { wrapper: harness.wrapper },
    );
    // Both groups' outcomes land on the same row — the status line counts
    // both fields as checked, not just whichever request resolved last.
    expect(
      await screen.findByText("1 suggestion · 2 fields checked"),
    ).toBeInTheDocument();
  });

  it("names the first basis field to add when the client never asked at all", async () => {
    // An empty name leaves categoryId's basis insufficient
    // (`isBasisSufficient`), so no request ever goes out.
    const record = fixtureRecord({
      id: testShortcode("product", "unasked"),
      name: "",
      brandName: null,
      categoryId: null,
    });
    const operations: EntitySuggestionsOperations = {
      suggestFields: ai.suggestFields.withTransport(async () => ({
        suggestions: {},
      })),
    };
    render(
      <RecordSuggestionsProvider
        entity="product"
        records={[record]}
        fieldKeys={["categoryId"]}
        operations={operations}

        storedSuggestionOperations={emptyStoredSuggestionOperations}
      >
        <span>row</span>
      </RecordSuggestionsProvider>,
      { wrapper: harness.wrapper },
    );
    expect(
      await screen.findByText("Not checked — add a name first"),
    ).toBeInTheDocument();
  });
});

it("reads effective governed suggestion values without falling back to stale plain slots", () => {
  const tags = {
    current: {
      assignment: {
        kind: "value",
        value: ["stored-tag"],
        ownership: { kind: "record" },
      },
      controls: {
        kind: "editable",
        canSetNone: false,
        canConfirm: false,
        reset: { kind: "unavailable" },
      },
    },
    result: {
      kind: "live",
      decision: {
        outcome: { kind: "value", value: ["effective-tag"] },
        provenance: null,
      },
    },
    work: { kind: "idle" },
  };
  const record = {
    id: testShortcode("product", "canonical-tags"),
    name: "Synthetic tag evidence",
    tags: ["stale-plain-tag"],
    fields: { tags },
  };
  expect(
    suggestionRecordFieldValue(harness.queryClient, "product", record, "tags"),
  ).toEqual(["effective-tag"]);
  expect(
    fieldSuggestionBasisFromRecord(
      harness.queryClient,
      "product",
      { targets: [], basisKeys: ["tags"] },
      record,
    ).tags,
  ).toBe('["effective-tag"]');
  expect(
    suggestionRecordFieldValue(
      harness.queryClient,
      "product",
      {
        ...record,
        fields: { tags: { ...tags, result: { kind: "missing" } } },
      },
      "tags",
    ),
  ).toBeUndefined();
  expect(
    suggestionRecordFieldValue(
      harness.queryClient,
      "product",
      {
        ...record,
        fields: {
          tags: {
            ...tags,
            result: {
              kind: "live",
              decision: {
                outcome: { kind: "empty", reason: "unset" },
                provenance: null,
              },
            },
          },
        },
      },
      "tags",
    ),
  ).toBeNull();
  expect(
    suggestionRecordFieldValue(
      harness.queryClient,
      "product",
      { id: record.id, tags: record.tags },
      "tags",
    ),
  ).toBeUndefined();
});
