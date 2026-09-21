import type {
  FieldSuggestionsInput,
  FieldSuggestionsOut,
} from "@cubby/schemas/ai";
import { inventoryEntryOut } from "@cubby/schemas/inventory";
import { testShortcode } from "@cubby/schemas/testing";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  value: "food",
  label: "Food",
  confidence: "high" as const,
  probability: 0.97,
  detail: null,
  reasoning: "",
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
  const record = { id, name, manufacturer: null, category: null };
  return (
    <RecordSuggestionsProvider
      entity="product"
      records={visible ? [record] : []}
      fieldKeys={["category"]}
      operations={operations}
    >
      {visible ? (
        <RecordFieldSuggestion record={record} field="category">
          <span>Empty category</span>
          <FieldSuggestionApply
            source={{
              entity: "product",
              basisMode: "provided",
              targets: ["category"],
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
        return { suggestions: { category: food } };
      }),
    };
    const view = render(<Surface name="red apple" operations={operations} />, {
      wrapper: harness.wrapper,
    });
    await screen.findByText("Suggested: Food");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.basisMode).toBe("provided");
    view.rerender(<Surface name="steel wrench" operations={operations} />);
    expect(screen.queryByText("Suggested: Food")).not.toBeInTheDocument();
    await waitFor(() => expect(calls).toHaveLength(2));
    await act(async () => {
      finish({
        suggestions: { category: { ...food, value: "tools", label: "Tools" } },
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

  it("accepts a nested inventory reference through the normal update contract and preserves the value after failure", async () => {
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
    await screen.findByRole("alert");
    expect(screen.getByText("Garage")).toBeInTheDocument();
    expect(commands[0]).toEqual({
      action: "update",
      entity: "inventory",
      id: record.id,
      data: { locationId },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use suggestion" }));
    await waitFor(() =>
      expect(screen.queryByText("Suggested: Workshop")).not.toBeInTheDocument(),
    );
    expect(commands).toHaveLength(2);
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
    expect(basis).toEqual({ productId });
  });
});
