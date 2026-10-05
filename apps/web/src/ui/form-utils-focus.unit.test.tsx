import { act, fireEvent, render, screen } from "@testing-library/react";
import { useForm, type UseFormReturn } from "react-hook-form";
import { describe, expect, it } from "vitest";

import { SelectField, UnifiedTextField } from "./form-utils";
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

// Regression: a reference picker must retain RHF focus registration. Both
// value adapters render through the one binding in `entity-value-field.tsx`.
it("focuses an invalid reference picker", () => {
  function Harness() {
    const form = useForm<{ reference: string | null }>({
      defaultValues: { reference: null },
    });
    return (
      <>
        <EntityValueField
          form={form}
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
        <button
          onClick={() =>
            form.setError(
              "reference",
              { message: "Select a location" },
              { shouldFocus: true },
            )
          }
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
