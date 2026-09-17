import { zodResolver } from "@hookform/resolvers/zod";
import { fireEvent, render, screen } from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { EntityPrimitiveFields } from "./entity-primitive-fields";

type IngredientValues = { name: string; usuallyOnHand: boolean };
type NumericValues = Record<string, number | null | undefined>;

function TestForm({
  onSubmit,
  mode = "create",
}: {
  onSubmit: (values: IngredientValues) => void;
  mode?: "create" | "edit";
}) {
  const schema = z.object({
    name: z.string().min(1, "Name is required"),
    usuallyOnHand: z.boolean(),
  });
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { name: "", usuallyOnHand: false },
  });
  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <EntityPrimitiveFields
          entity="ingredient"
          mode={mode}
          exclude={["aliases", "naKinds"]}
          options={{ name: { placeholder: "Enter ingredient name" } }}
        />
        <button type="submit">Save</button>
      </form>
    </FormProvider>
  );
}

function NumericForm({
  entity,
  field,
  exclude,
  defaultValue,
  onSubmit,
}: {
  entity: "product" | "ledgerTransfer";
  field: string;
  exclude: readonly string[];
  defaultValue: number | null;
  onSubmit: (values: NumericValues) => void;
}) {
  const form = useForm<NumericValues>({
    defaultValues: { [field]: defaultValue },
  });
  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <EntityPrimitiveFields
          entity={entity}
          mode="create"
          exclude={exclude}
        />
        <button type="submit">Save</button>
      </form>
    </FormProvider>
  );
}

function NestedIngredientForm({
  onSubmit,
}: {
  onSubmit: (values: { draft: IngredientValues }) => void;
}) {
  const form = useForm({
    defaultValues: { draft: { name: "", usuallyOnHand: false } },
  });
  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <EntityPrimitiveFields
          entity="ingredient"
          mode="create"
          include={["name", "usuallyOnHand"]}
          paths={{ name: "draft.name", usuallyOnHand: "draft.usuallyOnHand" }}
        />
        <button type="submit">Save nested</button>
      </form>
    </FormProvider>
  );
}

function RepeatedCheckboxes() {
  const form = useForm({ defaultValues: { usuallyOnHand: false } });
  return (
    <FormProvider {...form}>
      <EntityPrimitiveFields
        entity="ingredient"
        mode="create"
        include={["usuallyOnHand"]}
      />
      <EntityPrimitiveFields
        entity="ingredient"
        mode="create"
        include={["usuallyOnHand"]}
      />
    </FormProvider>
  );
}

function IngredientSections() {
  const form = useForm({ defaultValues: { name: "", usuallyOnHand: false } });
  return (
    <FormProvider {...form}>
      <section aria-label="Identity fields">
        <EntityPrimitiveFields
          entity="ingredient"
          mode="create"
          section="identity"
        />
      </section>
      <section aria-label="Planning fields">
        <EntityPrimitiveFields
          entity="ingredient"
          mode="create"
          section="main"
        />
      </section>
    </FormProvider>
  );
}

function LocationMainFields() {
  const form = useForm({ defaultValues: { name: "", imageOrder: "[]" } });
  return (
    <FormProvider {...form}>
      <EntityPrimitiveFields entity="location" mode="edit" section="main" />
    </FormProvider>
  );
}

function RecipeNotesForm({
  onSubmit,
}: {
  onSubmit: (values: { notes: string | null }) => void;
}) {
  const form = useForm<{ notes: string | null }>({
    defaultValues: { notes: "Original note" },
  });
  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <EntityPrimitiveFields
          entity="recipe"
          mode="edit"
          include={["notes"]}
          options={{ notes: { rows: 4, placeholder: "Recipe notes" } }}
        />
        <button type="submit">Save notes</button>
      </form>
    </FormProvider>
  );
}

describe("EntityPrimitiveFields", () => {
  it("keeps serialized image ordering in the specialized image editor", () => {
    render(<LocationMainFields />);
    expect(screen.getByRole("textbox", { name: "Name" })).toBeVisible();
    // Name and the notes textarea are the only textboxes: `imageOrder` must
    // never surface as a text control.
    expect(
      screen.getAllByRole("textbox").map((el) => el.getAttribute("name")),
    ).toEqual(["name", "notes"]);
    expect(screen.queryByLabelText(/image order/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("selects declared sections without duplicating controls or guessing specialized renderers", () => {
    render(<IngredientSections />);
    expect(screen.getAllByRole("textbox", { name: "Name" })).toHaveLength(1);
    expect(
      screen.getAllByRole("checkbox", { name: "Usually on hand" }),
    ).toHaveLength(1);
    expect(
      screen.getByRole("region", { name: "Identity fields" }),
    ).toContainElement(screen.getByRole("textbox", { name: "Name" }));
    expect(
      screen.getByRole("region", { name: "Planning fields" }),
    ).toContainElement(
      screen.getByRole("checkbox", { name: "Usually on hand" }),
    );
    expect(screen.queryByText("Aliases")).not.toBeInTheDocument();
  });

  it("preserves nullable Markdown notes and textarea sizing when clearing", async () => {
    let submitted: unknown;
    render(
      <RecipeNotesForm
        onSubmit={(values) => {
          submitted = values;
        }}
      />,
    );
    const notes = screen.getByRole("textbox", { name: "Notes" });
    expect(notes).toHaveAttribute("rows", "4");
    expect(notes).toHaveAttribute("placeholder", "Recipe notes");
    fireEvent.change(notes, { target: { value: "" } });
    fireEvent.submit(screen.getByRole("button", { name: "Save notes" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(submitted).toEqual({ notes: null });
  });

  it("renders model labels and help text as accessible controls", () => {
    render(<TestForm onSubmit={() => undefined} />);

    expect(screen.getByRole("textbox", { name: "Name" })).toHaveAttribute(
      "placeholder",
      "Enter ingredient name",
    );
    expect(
      screen.getByRole("checkbox", { name: "Usually on hand" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Assume I have enough for recipe planning. Recorded inventory stays separate.",
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Name")).toHaveLength(1);
    const checkbox = screen.getByRole("checkbox", { name: "Usually on hand" });
    expect(checkbox.getAttribute("aria-describedby")).toContain("description");
  });

  it("submits mapped nested paths through RHF", async () => {
    let submitted: unknown;
    render(
      <NestedIngredientForm onSubmit={(values) => (submitted = values)} />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Flour" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Usually on hand" }));
    fireEvent.submit(screen.getByRole("button", { name: "Save nested" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(submitted).toEqual({
      draft: { name: "Flour", usuallyOnHand: true },
    });
  });

  it("scopes repeated checkbox ids while preserving label targets", () => {
    render(<RepeatedCheckboxes />);
    const checkboxes = screen.getAllByRole("checkbox", {
      name: "Usually on hand",
    });
    const ids = checkboxes.map((checkbox) => checkbox.id);
    expect(new Set(ids).size).toBe(2);
    const labelTargets = Array.from(document.querySelectorAll("label")).map(
      (label) => label.getAttribute("for"),
    );
    expect(labelTargets.filter(Boolean)).toHaveLength(2);
    expect(new Set(labelTargets.filter(Boolean)).size).toBe(2);
    expect(ids.every((id) => id.length > 0)).toBe(true);
  });

  it("updates checkbox values and submits them through the real RHF context", async () => {
    let submitted: unknown;
    render(<TestForm onSubmit={(values) => (submitted = values)} />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Usually on hand" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Flour" },
    });
    fireEvent.submit(screen.getByRole("button", { name: "Save" }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(submitted).toEqual({ name: "Flour", usuallyOnHand: true });
  });

  it("keeps RHF validation errors attached to the labeled text control", async () => {
    render(<TestForm onSubmit={() => undefined} />);

    fireEvent.submit(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Name is required",
    );
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("does not render excluded specialized fields", () => {
    render(<TestForm onSubmit={() => undefined} />);

    expect(screen.queryByText("Aliases")).not.toBeInTheDocument();
    expect(screen.queryByText("Na Kinds")).not.toBeInTheDocument();
  });

  it.each([
    ["nullable", "product", "expectedQuantity", null, null],
    ["required", "ledgerTransfer", "amount", 4, undefined],
  ] as const)(
    "keeps empty %s numeric values truthful",
    async (_, entity, field, initial, expected) => {
      let submitted: unknown;
      const excluded =
        entity === "product"
          ? [
              "name",
              "aliases",
              "tags",
              "upc",
              "isbn",
              "fdc_id",
              "manufacturer",
              "model",
              "notes",
              "category",
              "ingredientId",
              "price",
              "unitMappings",
              "externalIds",
              "usdaUnavailable",
              "stockTracked",
              "pendingImageIds",
            ]
          : [
              "fromPartyId",
              "toPartyId",
              "date",
              "notes",
              "sourceClaims",
              "evidenceTransactionIds",
            ];
      render(
        <NumericForm
          entity={entity}
          field={field}
          exclude={excluded}
          defaultValue={initial}
          onSubmit={(values) => (submitted = values)}
        />,
      );
      const input = screen.getByRole("spinbutton", {
        name: /quantity|amount/i,
      });
      fireEvent.change(input, { target: { value: "" } });
      fireEvent.submit(screen.getByRole("button", { name: "Save" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(submitted).toEqual({ [field]: expected });
    },
  );
});
