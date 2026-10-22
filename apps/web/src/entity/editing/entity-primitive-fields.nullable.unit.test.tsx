import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { EntityPrimitiveFields } from "./entity-primitive-fields";

const valuesSchema = z.object({
  notes: z.string().nullable(),
  price: z.number().nullable(),
});
type Values = z.infer<typeof valuesSchema>;
const fields = ["notes", "price"];
const nestedExpenseSchema = z.object({
  draft: z.object({ cost: z.number().nullable(), date: z.string().nullable() }),
});
const dateFields = ["cost", "date"];
const datePaths = { cost: "draft.cost", date: "draft.date" };

function NestedExpenseFields({
  save,
}: {
  save: (values: z.infer<typeof nestedExpenseSchema>) => void;
}) {
  const form = useForm<z.infer<typeof nestedExpenseSchema>>({
    defaultValues: { draft: { cost: 0, date: "2026-01-02" } },
  });
  return (
    <FormProvider {...form}>
      <form
        onSubmit={form.handleSubmit((values) =>
          save(nestedExpenseSchema.parse(values)),
        )}
      >
        <EntityPrimitiveFields
          entity="expense"
          mode="edit"
          include={dateFields}
          paths={datePaths}
        />
        <button type="submit">Save</button>
      </form>
    </FormProvider>
  );
}

function NullableProductFields({ save }: { save: (values: Values) => void }) {
  const form = useForm<Values>({
    defaultValues: { notes: "Reusable container", price: 0 },
  });
  return (
    <FormProvider {...form}>
      <form
        onSubmit={form.handleSubmit((values) =>
          save(valuesSchema.parse(values)),
        )}
      >
        <EntityPrimitiveFields entity="product" mode="edit" include={fields} />
        <button type="submit">Save</button>
      </form>
    </FormProvider>
  );
}

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

it("clears a nested expense date using its mapped cost and date paths", async () => {
  const save = vi.fn();
  render(<NestedExpenseFields save={save} />, { wrapper: harness.wrapper });
  fireEvent.click(screen.getByRole("button", { name: "Date unknown" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({ draft: { cost: 0, date: null } }),
  );
});

it("clears nullable text and numbers as null without treating zero as empty", async () => {
  const save = vi.fn();
  render(<NullableProductFields save={save} />, { wrapper: harness.wrapper });
  fireEvent.change(screen.getByLabelText("Notes", { exact: true }), {
    target: { value: "" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(save).toHaveBeenLastCalledWith({ notes: null, price: 0 }),
  );
  fireEvent.change(screen.getByLabelText("Valuation price", { exact: true }), {
    target: { value: "" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(save).toHaveBeenLastCalledWith({ notes: null, price: null }),
  );
});

const spanValuesSchema = z.object({
  draft: z.object({
    dueDate: z.string().nullable(),
    dueEndDate: z.string().nullable(),
  }),
});
function TaskSpanFields({
  save,
}: {
  save: (values: z.infer<typeof spanValuesSchema>) => void;
}) {
  const form = useForm<z.infer<typeof spanValuesSchema>>({
    defaultValues: { draft: { dueDate: null, dueEndDate: "2026-10-30" } },
  });
  return (
    <FormProvider {...form}>
      <form
        onSubmit={form.handleSubmit((values) =>
          save(spanValuesSchema.parse(values)),
        )}
      >
        <EntityPrimitiveFields
          entity="task"
          mode="edit"
          include={["dueDate", "dueEndDate"]}
          paths={{ dueDate: "draft.dueDate", dueEndDate: "draft.dueEndDate" }}
        />
        <button type="submit">Save</button>
      </form>
    </FormProvider>
  );
}

it("preserves mapped span values until an explicit change and submits a single date without a stale end", async () => {
  const save = vi.fn();
  render(<TaskSpanFields save={save} />, { wrapper: harness.wrapper });
  fireEvent.click(screen.getByRole("button", { name: "Due", exact: true }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Done", exact: true }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
  await waitFor(() =>
    expect(save).toHaveBeenLastCalledWith({
      draft: { dueDate: null, dueEndDate: "2026-10-30" },
    }),
  );

  fireEvent.click(screen.getByRole("button", { name: "Due", exact: true }));
  const start = await screen.findByRole("textbox", { name: "Due start" });
  fireEvent.change(start, { target: { value: "Oct 28, 2026" } });
  fireEvent.keyDown(start, { key: "Enter" });
  fireEvent.click(
    screen.getByRole("button", { name: "Single date", exact: true }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Done", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
  await waitFor(() =>
    expect(save).toHaveBeenLastCalledWith({
      draft: { dueDate: "2026-10-28", dueEndDate: null },
    }),
  );

  fireEvent.click(screen.getByRole("button", { name: "Due", exact: true }));
  fireEvent.click(
    screen.getByRole("button", { name: "Clear dates", exact: true }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Done", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
  await waitFor(() =>
    expect(save).toHaveBeenLastCalledWith({
      draft: { dueDate: null, dueEndDate: null },
    }),
  );
});
