import type {
  FieldSuggestionsInput,
  FieldSuggestionsOut,
} from "@cubby/schemas/ai";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  FormProvider,
  useForm,
  useFormState,
  useWatch,
  type FieldValues,
  type UseFormReturn,
} from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ai } from "~/lib/ai.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  FIELD_SUGGEST_DEBOUNCE_MS,
  type EntitySuggestionsOperations,
} from "./field-suggestion";
import { FieldSuggestionProvider } from "./field-suggestion-provider";
import { useAutoFieldSuggestion } from "./use-auto-field-suggestion";

let harness: ReturnType<typeof createBrowserTestHarness>;
let calls: FieldSuggestionsInput[];

beforeEach(() => {
  // Real timers: TanStack Query's notify path schedules a zero-delay
  // `setTimeout` after the fetch promise settles, which needs an event-loop
  // tick fake timers don't reliably deliver alongside a microtask-only fake
  // transport — see the debounce test below for the one place that still
  // needs precise control, done with plain synchronous `fireEvent` calls
  // instead of advancing a clock.
  harness = createBrowserTestHarness();
  calls = [];
});

afterEach(() => {
  harness.dispose();
});

function operationsReturning(
  respond: (input: FieldSuggestionsInput) => FieldSuggestionsOut,
): EntitySuggestionsOperations {
  return {
    suggestFields: ai.suggestFields.withTransport(async ({ input }) => {
      calls.push(input);
      return respond(input);
    }),
  };
}

/** A real, short delay — used only to assert a call did *not* happen, which
 * `waitFor` (a positive-assertion poll) cannot express. */
function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reads the DOM-rendered `isDirty` indicator a `Probe` mounts for `target`. */
function isDirtyText(target: string): string | null {
  return screen.getByTestId(`dirty-${target}`).textContent;
}

function Probe({
  form,
  target,
  valueKind = "id",
}: {
  form: UseFormReturn<FieldValues>;
  target: string;
  valueKind?: "id" | "item";
}) {
  // Subscribed so this fiber re-renders on any write to `target` — mirrors
  // `AutoSuggestSlot` always being mounted inside the primitive's Controller,
  // which is what lets the hook observe its own silent auto-fill.
  useWatch({ control: form.control, name: target });
  // A dedicated, DOM-rendered `isDirty` subscription: reading
  // `form.formState` directly from the captured `form` instance (outside any
  // subscribed render) is not guaranteed fresh — RHF's `formState` is a lazy
  // proxy meant to be read through a hook. Asserting on rendered text instead
  // of the raw object sidesteps that staleness entirely.
  const formState = useFormState({ control: form.control, name: target });
  const isDirty = form.getFieldState(target, formState).isDirty;
  const { apply } = useAutoFieldSuggestion({
    form,
    name: target,
    field: target,
    valueKind,
  });
  return (
    <div>
      {/* `register` (not just `useWatch`) so RHF tracks `dirtyFields` for
          this path the way a real `Controller`-backed primitive would. */}
      <input aria-label={target} {...form.register(target)} />
      <output data-testid={`dirty-${target}`}>{String(isDirty)}</output>
      <button type="button" onClick={apply}>
        Apply {target}
      </button>
    </div>
  );
}

function Harness({
  entity,
  mode,
  fieldKeys,
  valueKind,
  textFields,
  operations,
  onReady,
}: {
  entity: "task" | "inventory";
  mode: "create" | "edit";
  /** One `Probe` (and one `AutoSuggestSlot`-equivalent hook instance) per
   * key, matching how every suggest-enabled field in a real form mounts its
   * own slot. */
  fieldKeys: readonly string[];
  valueKind?: "id" | "item";
  textFields: readonly string[];
  operations: EntitySuggestionsOperations;
  onReady: (form: UseFormReturn<FieldValues>) => void;
}) {
  const defaultValues: FieldValues = {};
  for (const key of fieldKeys) defaultValues[key] = "";
  for (const field of textFields) defaultValues[field] = "";
  const form = useForm<FieldValues>({ defaultValues });
  onReady(form);
  return (
    <FormProvider {...form}>
      <FieldSuggestionProvider
        entity={entity}
        mode={mode}
        fieldKeys={fieldKeys}
        operations={operations}
      >
        {textFields.map((field) => (
          <input key={field} aria-label={field} {...form.register(field)} />
        ))}
        {fieldKeys.map((key) => (
          <Probe key={key} form={form} target={key} valueKind={valueKind} />
        ))}
      </FieldSuggestionProvider>
    </FormProvider>
  );
}

const tradeSuggestion = {
  value: "cabinetry",
  label: "Cabinetry",
  detail: null,
  confidence: "high",
  probability: 0.95,
  reasoning: "",
} as const;

describe("useAutoFieldSuggestion", () => {
  it("auto-fills a silently-suggested value in create mode without dirtying the field", async () => {
    let form!: UseFormReturn<FieldValues>;
    const operations = operationsReturning(() => ({
      suggestions: { trade: tradeSuggestion },
    }));
    render(
      <Harness
        entity="task"
        mode="create"
        fieldKeys={["trade"]}
        textFields={["name"]}
        operations={operations}
        onReady={(f) => {
          form = f;
        }}
      />,
      { wrapper: harness.wrapper },
    );

    fireEvent.change(screen.getByLabelText("name"), {
      target: { value: "hang upper cabinets" },
    });
    await waitFor(() => expect(form.getValues("trade")).toBe("cabinetry"));

    expect(calls).toHaveLength(1);
    expect(isDirtyText("trade")).toBe("false");
  });

  // Regression: an auto-fill is the answer to the basis it was asked about.
  // When the next settled basis yields no suggestion (the model declined),
  // the untouched field must not keep the stale value — with no hint, it
  // would read as a deliberate pick.
  it("retracts a stale auto-fill when the current basis yields no suggestion", async () => {
    let form!: UseFormReturn<FieldValues>;
    const operations = operationsReturning((input) => ({
      suggestions: {
        trade: input.basis.name?.includes("cabinets") ? tradeSuggestion : null,
      },
    }));
    render(
      <Harness
        entity="task"
        mode="create"
        fieldKeys={["trade"]}
        textFields={["name"]}
        operations={operations}
        onReady={(f) => {
          form = f;
        }}
      />,
      { wrapper: harness.wrapper },
    );

    fireEvent.change(screen.getByLabelText("name"), {
      target: { value: "hang upper cabinets" },
    });
    await waitFor(() => expect(form.getValues("trade")).toBe("cabinetry"));

    fireEvent.change(screen.getByLabelText("name"), {
      target: { value: "pay the invoice" },
    });
    await waitFor(() => expect(calls).toHaveLength(2));
    await waitFor(() => expect(form.getValues("trade")).toBe(""));
    expect(isDirtyText("trade")).toBe("false");
  });

  it("never overwrites a manual pick, even after the basis changes again", async () => {
    let form!: UseFormReturn<FieldValues>;
    const operations = operationsReturning(() => ({
      suggestions: { trade: tradeSuggestion },
    }));
    render(
      <Harness
        entity="task"
        mode="create"
        fieldKeys={["trade"]}
        textFields={["name"]}
        operations={operations}
        onReady={(f) => {
          form = f;
        }}
      />,
      { wrapper: harness.wrapper },
    );

    act(() => {
      form.setValue("trade", "plumbing", { shouldDirty: true });
    });
    await waitFor(() => expect(isDirtyText("trade")).toBe("true"));

    fireEvent.change(screen.getByLabelText("name"), {
      target: { value: "hang upper cabinets, then redo the pipes" },
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    // Give the (never-taken) auto-fill effect a chance to run before asserting.
    await delay(100);

    expect(form.getValues("trade")).toBe("plumbing");
    expect(isDirtyText("trade")).toBe("true");
  });

  it("never auto-writes in edit mode, but apply() writes and dirties", async () => {
    let form!: UseFormReturn<FieldValues>;
    const operations = operationsReturning(() => ({
      suggestions: { trade: tradeSuggestion },
    }));
    render(
      <Harness
        entity="task"
        mode="edit"
        fieldKeys={["trade"]}
        textFields={["name"]}
        operations={operations}
        onReady={(f) => {
          form = f;
        }}
      />,
      { wrapper: harness.wrapper },
    );

    fireEvent.change(screen.getByLabelText("name"), {
      target: { value: "hang upper cabinets" },
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Apply trade" })).toBeEnabled(),
    );
    await delay(50);

    expect(form.getValues("trade")).toBe("");
    expect(isDirtyText("trade")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Apply trade" }));

    expect(form.getValues("trade")).toBe("cabinetry");
    expect(isDirtyText("trade")).toBe("true");
  });

  it.each([
    {
      description: "a plain text basis needs 2 characters",
      target: "projectId",
      short: "a",
      long: "ab",
    },
    {
      description:
        "a product-reference target needs 3 (the lexical search floor)",
      target: "subjectProductId",
      short: "ab",
      long: "abc",
    },
  ])(
    "does not query below the basis threshold: $description",
    async ({ target, short, long }) => {
      const operations = operationsReturning((input) => ({
        suggestions: Object.fromEntries(input.targets.map((t) => [t, null])),
      }));
      render(
        <Harness
          entity="task"
          mode="create"
          fieldKeys={[target]}
          textFields={["name"]}
          operations={operations}
          onReady={() => {}}
        />,
        { wrapper: harness.wrapper },
      );

      fireEvent.change(screen.getByLabelText("name"), {
        target: { value: short },
      });
      await delay(FIELD_SUGGEST_DEBOUNCE_MS + 150);
      expect(calls).toHaveLength(0);

      fireEvent.change(screen.getByLabelText("name"), {
        target: { value: long },
      });
      await waitFor(() => expect(calls).toHaveLength(1));
    },
  );

  it("collapses several quick basis changes into exactly one request", async () => {
    const operations = operationsReturning(() => ({
      suggestions: { trade: tradeSuggestion },
    }));
    render(
      <Harness
        entity="task"
        mode="create"
        fieldKeys={["trade"]}
        textFields={["name"]}
        operations={operations}
        onReady={() => {}}
      />,
      { wrapper: harness.wrapper },
    );

    const input = screen.getByLabelText("name");
    // Fired back-to-back with no await between them — real elapsed time is a
    // handful of milliseconds, well under the debounce window, so they
    // collapse into the single request for the last value.
    for (const value of ["h", "ha", "han", "hang", "hang c"]) {
      fireEvent.change(input, { target: { value } });
    }

    await waitFor(() => expect(calls).toHaveLength(1));
    await delay(150);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.basis.name).toBe("hang c");
  });

  it("sends null for a target it auto-filled itself on the next request", async () => {
    const operations = operationsReturning(() => ({
      suggestions: {
        projectId: {
          value: "PRJ-1",
          label: "Kitchen remodel",
          detail: null,
          confidence: "high",
          probability: 0.95,
          reasoning: "",
        },
        trade: null,
      },
    }));
    let form!: UseFormReturn<FieldValues>;
    render(
      <Harness
        entity="task"
        mode="create"
        fieldKeys={["projectId", "trade"]}
        textFields={["name"]}
        operations={operations}
        onReady={(f) => {
          form = f;
        }}
      />,
      { wrapper: harness.wrapper },
    );

    fireEvent.change(screen.getByLabelText("name"), {
      target: { value: "cabinets please" },
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.basis.projectId).toBeNull();

    // `projectId` is now silently auto-filled to "PRJ-1" and still untouched.
    await waitFor(() => expect(form.getValues("projectId")).toBe("PRJ-1"));

    // A further basis change must still send `null` for it, not "PRJ-1" —
    // the client never re-keys on its own write.
    fireEvent.change(screen.getByLabelText("name"), {
      target: { value: "cabinets please indeed" },
    });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.basis.projectId).toBeNull();
    expect(calls[1]?.basis.name).toBe("cabinets please indeed");
  });

  it("waits for the reference before querying a reference-only basis", async () => {
    const operations = operationsReturning(() => ({
      suggestions: {
        locationId: {
          value: "LOC-1",
          label: "Garage shelf",
          detail: null,
          confidence: "high",
          probability: 0.95,
          reasoning: "",
        },
      },
    }));
    render(
      <Harness
        entity="inventory"
        mode="create"
        fieldKeys={["locationId"]}
        textFields={["productId"]}
        operations={operations}
        onReady={() => {}}
      />,
      { wrapper: harness.wrapper },
    );

    await delay(FIELD_SUGGEST_DEBOUNCE_MS + 150);
    expect(calls).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("productId"), {
      target: { value: "PRD-1" },
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.basis.productId).toBe("PRD-1");
  });
});
