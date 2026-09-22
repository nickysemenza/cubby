import type {
  FieldSuggestionsInput,
  FieldSuggestionsOut,
} from "@cubby/schemas/ai";
import { inventoryEntryOut } from "@cubby/schemas/inventory";
import { productTopLevelOut } from "@cubby/schemas/product";
import { expenseOut } from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEntityMutationPort } from "~/entities/editing/use-entity-commands";
import { ai } from "~/lib/ai.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";
import type { EntityBrowserMutationInput } from "~/server/entity-kernel/contracts";

import {
  fieldSuggestionBasisFromRecord,
  suggestTargetsFor,
  type EntitySuggestionsOperations,
} from "./field-suggestion";
import { FieldSuggestionApply } from "./field-suggestion-apply";
import {
  RecordSuggestionsProvider,
  RecordFieldSuggestion,
  RecordSuggestionBoundary,
} from "./record-suggestions";

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});
const id = testShortcode("product", "first");
const food = {
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
  const record = { id, name, manufacturer: null, categoryId: null };
  return (
    <RecordSuggestionsProvider
      entity="product"
      records={visible ? [record] : []}
      fieldKeys={["categoryId"]}
      operations={operations}
    >
      {visible ? (
        <RecordFieldSuggestion record={record} field="categoryId">
          <span>Empty category</span>
          <FieldSuggestionApply
            source={{
              entity: "product",
              basisMode: "provided",
              targets: ["categoryId"],
              basis: { name, manufacturer: null },
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
        return { suggestions: { categoryId: food } };
      }),
    };
    const view = render(<Surface name="red apple" operations={operations} />, {
      wrapper: harness.wrapper,
    });
    await screen.findByText("Suggested: Food");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.basisMode).toBe("suggested");
    view.rerender(<Surface name="steel wrench" operations={operations} />);
    expect(screen.queryByText("Suggested: Food")).not.toBeInTheDocument();
    await waitFor(() => expect(calls).toHaveLength(2));
    await act(async () => {
      finish({
        suggestions: {
          categoryId: { ...food, value: "CAT-2224", label: "Tools" },
        },
      });
    });
    await screen.findByText("Suggested: Tools");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    view.rerender(
      <Surface name="steel wrench" operations={operations} visible={false} />,
    );
    view.rerender(<Surface name="steel wrench" operations={operations} />);
    expect(screen.queryByText("Suggested: Tools")).not.toBeInTheDocument();
    expect(screen.getByText("0 suggestions")).toBeInTheDocument();
    expect(calls).toHaveLength(2);
  });

  it("opens the normal editor with the saved value after acceptance fails", async () => {
    const record = {
      id: testShortcode("inventory", "bin"),
      product: { id: testShortcode("product", "bin"), name: "Storage bin" },
      location: { id: testShortcode("location", "old"), name: "Garage" },
    };
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
                ...mock(inventoryEntryOut, { seed: 1 }),
                id: record.id,
                locationId,
              },
              sideEffects: { backgroundBatches: [] },
            };
          },
        })}
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
    await screen.findByText("Suggested: Workshop");
    expect(calls).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Use suggestion" }));
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

  it("saves a remove (prune) suggestion by patching the array field, preserving collection:* tags", async () => {
    const record = {
      id: testShortcode("product", "tag-remove"),
      name: "Rain shell",
      manufacturer: "Jacquemus",
      categoryId: null,
      tags: ["jacquemus", "collection:favorites", "mount"],
    };
    const removeSuggestion = {
      value: "jacquemus",
      label: "Remove jacquemus",
      confidence: "high" as const,
      probability: 0.9,
      detail: "restates manufacturer",
      reasoning: "",
      alternatives: [],
      operation: "remove" as const,
      removals: [
        {
          value: "jacquemus",
          probability: 0.9,
          reason: "restates manufacturer",
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
        tags: ["collection:favorites", "mount"],
      },
    });
    render(
      <RecordSuggestionsProvider
        entity="product"
        records={[record]}
        fieldKeys={["tags"]}
        operations={operations}
        readRecord={async () => record}
        mutationPort={createEntityMutationPort({
          execute: async (command) => {
            commands.push(command);
            return {
              action: "update",
              entity: "product",
              item,
              sideEffects: { backgroundBatches: [] },
            };
          },
        })}
      >
        <RecordFieldSuggestion record={record} field="tags">
          <span>current tags</span>
        </RecordFieldSuggestion>
      </RecordSuggestionsProvider>,
      { wrapper: harness.wrapper },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Remove tags" }));
    await waitFor(() => expect(commands).toHaveLength(1));
    expect(commands[0]).toEqual({
      action: "update",
      entity: "product",
      id: record.id,
      data: { tags: ["collection:favorites", "mount"] },
    });
  });

  it("refuses a remove suggestion once its removal is no longer present", async () => {
    const record = {
      id: testShortcode("product", "tag-stale"),
      name: "Rain shell",
      manufacturer: "Jacquemus",
      categoryId: null,
      tags: ["jacquemus", "mount"],
    };
    const removeSuggestion = {
      value: "jacquemus",
      label: "Remove jacquemus",
      confidence: "high" as const,
      probability: 0.9,
      detail: "restates manufacturer",
      reasoning: "",
      alternatives: [],
      operation: "remove" as const,
      removals: [
        {
          value: "jacquemus",
          probability: 0.9,
          reason: "restates manufacturer",
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
        // click — a sibling basis field (manufacturer) is unchanged, so only
        // the every-removal-still-present check catches this.
        readRecord={async () => ({ ...record, tags: ["mount"] })}
        mutationPort={createEntityMutationPort({
          execute: async (command) => {
            commands.push(command);
            throw new Error("must not write");
          },
        })}
      >
        <RecordFieldSuggestion record={record} field="tags">
          <span>current tags</span>
        </RecordFieldSuggestion>
      </RecordSuggestionsProvider>,
      { wrapper: harness.wrapper },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Remove tags" }));
    await screen.findByRole("alert");
    expect(commands).toHaveLength(0);
  });

  it("reads inventory's nested product reference as the location suggestion basis", () => {
    const productId = testShortcode("product", "second");
    const basis = fieldSuggestionBasisFromRecord(
      "inventory",
      suggestTargetsFor("inventory", ["locationId"]),
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
    const targets = suggestTargetsFor("inventory", ["locationId"]);
    const before = fieldSuggestionBasisFromRecord("inventory", targets, {
      product: { id: productId, name: "Storage bin" },
    });
    const after = fieldSuggestionBasisFromRecord("inventory", targets, {
      product: { id: productId, name: "Garage tote" },
    });

    expect(after.productId).toBe(before.productId);
    expect(after.__referenceLabels).not.toBe(before.__referenceLabels);
  });

  it("rechecks authoritative eligibility before accepting a rendered proposal", async () => {
    const record = {
      id: testShortcode("task", "stale"),
      name: "Install a circuit breaker",
      trade: null,
    };
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
          fieldResolutions: {
            trade: {
              mode: "inherit",
              storedValue: null,
              value: "electrical",
              fallbackValue: "electrical",
              source: "Project default",
              sourceEntity: null,
              matchesFallback: true,
              canReset: false,
            },
          },
        })}
        mutationPort={createEntityMutationPort({
          execute: async (command) => {
            commands.push(command);
            throw new Error("must not write");
          },
        })}
      >
        <RecordFieldSuggestion record={record} field="trade">
          <span>Empty trade</span>
        </RecordFieldSuggestion>
      </RecordSuggestionsProvider>,
      { wrapper: harness.wrapper },
    );

    const errorSpy = vi.spyOn(toast, "error").mockImplementation(() => "");
    await screen.findByText("Suggested: Electrical");
    fireEvent.click(screen.getByRole("button", { name: "Use suggestion" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Suggestion inputs changed");
    expect(calls).toBe(1);
    expect(commands).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it("accepts a suggestion whose request basis was the union of every visible target, not just the clicked field's own basis (regression: 'Suggestion inputs changed')", async () => {
    // costType's own suggest basis is only ["name", "productId", "vendor"].
    // With trade, vendor, and projectId also visible on this row, the
    // request-building basis additionally picks up "notes", "orderId",
    // "projectId", and "date" (from trade's and projectId's own bases,
    // and the expense inheritance-context keys). Accepting the costType
    // suggestion must re-derive that same wider key set, not silently
    // narrow to costType's own basis keys, or the fingerprint compare
    // manufactures a false "inputs changed" refusal.
    const record = {
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
    };
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
        readRecord={async () => record}
        mutationPort={createEntityMutationPort({
          execute: async (command) => {
            commands.push(command);
            return {
              action: "update",
              entity: "expense",
              item: {
                ...mock(expenseOut, { seed: 1 }),
                id: record.id,
                costType: "tools",
              },
              sideEffects: { backgroundBatches: [] },
            };
          },
        })}
      >
        <RecordFieldSuggestion record={record} field="costType">
          <span>Materials</span>
        </RecordFieldSuggestion>
      </RecordSuggestionsProvider>,
      { wrapper: harness.wrapper },
    );
    await screen.findByText("Suggested: Tools");
    expect(calls.length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Use suggestion" }));
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
    const record = {
      id: testShortcode("task", "redundant"),
      name: "Replace electrical panel",
      trade: "plumbing",
      fieldResolutions: {
        trade: {
          mode: "explicit" as const,
          storedValue: "plumbing",
          value: "plumbing",
          fallbackValue: "electrical",
          source: "Task override",
          sourceEntity: null,
          matchesFallback: false,
          canReset: true,
        },
      },
    };
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
      >
        <RecordFieldSuggestion record={record} field="trade">
          <span>Plumbing</span>
        </RecordFieldSuggestion>
      </RecordSuggestionsProvider>,
      { wrapper: harness.wrapper },
    );

    await screen.findByText("Suggested: Electrical");
    fireEvent.click(
      screen.getByRole("button", { name: "Use inherited value" }),
    );
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
      storedValue: null,
      value: null,
      fallbackValue: null,
      source: "Purchase default",
      sourceEntity: null,
      matchesFallback: false,
      canReset: false,
    };
    render(
      <RecordSuggestionsProvider
        entity="expense"
        records={[
          {
            id: testShortcode("expense", "inherited"),
            name: "Permit fee",
            lineKind: "principal",
            projectId: null,
            trade: null,
            fieldResolutions: {
              projectId: { ...resolution, mode: "inherit" },
              trade: { ...resolution, mode: "none" },
            },
          },
        ]}
        fieldKeys={["projectId", "trade"]}
        operations={operations}
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
});
