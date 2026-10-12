import type { FieldSuggestion } from "@cubby/schemas/ai";
import { render, screen, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { FormProvider, useForm, type FieldValues } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ai } from "~/integrations/tanstack-query/generated/catalog.gen";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { AutoSuggestSlot } from "./auto-suggest-slot";
import type { EntitySuggestionsOperations } from "./field-suggestion";
import { FieldSuggestionProvider } from "./field-suggestion-provider";

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

const cabinetry: FieldSuggestion = {
  value: "cabinetry",
  label: "Cabinetry",
  detail: null,
  confidence: "high",
  probability: 0.95,
  reasoning: "",
  alternatives: [],
  operation: "set",
  removals: [],
};

function operations(suggestion: FieldSuggestion): EntitySuggestionsOperations {
  return {
    suggestFields: ai.suggestFields.withTransport(async () => ({
      suggestions: { trade: suggestion },
      outcomes: {
        trade: {
          kind: "evaluated",
          answer: "pick",
          confidence: suggestion.confidence,
          probability: suggestion.probability,
          alternatives: suggestion.alternatives,
        },
      },
    })),
  };
}

function Harness({
  mode,
  defaultTrade,
  suggestion,
}: {
  mode: "create" | "edit";
  defaultTrade: string;
  suggestion: FieldSuggestion;
}) {
  const form = useForm<FieldValues>({
    defaultValues: { name: "Replace electrical panel", trade: defaultTrade },
  });
  return (
    <FormProvider {...form}>
      <FieldSuggestionProvider
        entity="task"
        mode={mode}
        fieldKeys={["trade"]}
        operations={operations(suggestion)}
      >
        <input aria-label="name" {...form.register("name")} />
        <AutoSuggestSlot form={form} name="trade" field="trade" />
      </FieldSuggestionProvider>
    </FormProvider>
  );
}

// A form's status line reports every checked field; the field itself shows
// only a proposal it can act on, so agreements and fills stay off the field.
describe("AutoSuggestSlot outcome mark", () => {
  it("keeps a silent create-mode auto-fill off the field", async () => {
    render(<Harness mode="create" defaultTrade="" suggestion={cabinetry} />, {
      wrapper: harness.wrapper,
    });
    // The auto-fill effect only fires once the field is watched as dirty-free
    // and the query has settled; nudging `name` re-triggers the debounced basis.
    fireEvent.change(screen.getByLabelText("name"), {
      target: { value: "Replace electrical panel, redo" },
    });
    await waitFor(() =>
      expect(screen.getByText(/1 field checked/)).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: /Filled in/ })).toBeNull();
  });

  it("keeps an edit-mode agreement off the field", async () => {
    render(
      <Harness mode="edit" defaultTrade="cabinetry" suggestion={cabinetry} />,
      { wrapper: harness.wrapper },
    );
    await waitFor(() =>
      expect(
        screen.getByText("No suggestions · 1 field checked"),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: /Agrees with/ })).toBeNull();
  });
});
