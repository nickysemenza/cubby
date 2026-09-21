import { act, fireEvent, render, screen } from "@testing-library/react";
import { useForm, type UseFormReturn } from "react-hook-form";
import { describe, expect, it } from "vitest";

import { ComboboxField, SelectField, UnifiedTextField } from "./form-utils";
import { EntityValueField } from "./form-utils/entity-value-field";

interface Values {
  name: string;
}

describe("UnifiedTextField focus", () => {
  it("focuses on mount without disrupting React Hook Form registration", () => {
    let form: UseFormReturn<Values> | undefined;

    function Harness() {
      form = useForm<Values>({ defaultValues: { name: "" } });
      return (
        <UnifiedTextField
          form={form}
          name="name"
          label="Name"
          placeholder="Name"
          focusOnMount
        />
      );
    }

    render(<Harness />);
    const input = screen.getByRole("textbox", { name: "Name" });
    expect(input).toHaveFocus();

    fireEvent.change(input, { target: { value: "Updated" } });
    expect(form?.getValues("name")).toBe("Updated");
  });
});

// Regression: SelectField dropped RHF's ref, so validation could not focus it.
it("focuses the select input through form registration and preserves label casing", () => {
  let form: UseFormReturn<Values> | undefined;
  function Harness() {
    form = useForm<Values>({ defaultValues: { name: "" } });
    return (
      <SelectField
        form={form}
        name="name"
        label="Cost type"
        options={[{ value: "materials", label: "Materials" }]}
      />
    );
  }
  render(<Harness />);
  act(() =>
    form?.setError(
      "name",
      { message: "Choose a cost type" },
      { shouldFocus: true },
    ),
  );
  expect(screen.getByRole("combobox", { name: "Cost type" })).toHaveFocus();
  expect(screen.getByText("Choose a cost type")).toBeInTheDocument();
});

// Both id-valued and object-valued references must retain RHF focus registration.
it.each(["id", "object"])("focuses an invalid %s reference picker", (kind) => {
  function Harness() {
    const idForm = useForm<{ reference: string | null }>({
      defaultValues: { reference: null },
    });
    const objectForm = useForm<{
      reference: { id: string; name: string } | null;
    }>({ defaultValues: { reference: null } });
    return (
      <>
        {kind === "id" ? (
          <EntityValueField
            form={idForm}
            name="reference"
            label="Parent location"
            entity="location"
            SearchProvider={({ children }) =>
              children({
                items: [],
                isLoading: false,
                onSearchChange: () => undefined,
                onOpenChange: () => undefined,
              })
            }
          />
        ) : (
          <ComboboxField
            form={objectForm}
            name="reference"
            label="Parent location"
            entity="location"
            items={[]}
            onSearchChange={() => undefined}
          />
        )}
        <button
          onClick={() => {
            if (kind === "id")
              idForm.setError(
                "reference",
                { message: "Select a location" },
                { shouldFocus: true },
              );
            else
              objectForm.setError(
                "reference",
                { message: "Select a location" },
                { shouldFocus: true },
              );
          }}
        >
          Validate
        </button>
      </>
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Validate" }));
  expect(
    screen.getByRole("combobox", { name: "Parent location" }),
  ).toHaveFocus();
});
