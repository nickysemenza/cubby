import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { expect, it } from "vitest";

import { PickerField } from "../../entity/forms/picker-field";

// Regression: a reference picker must retain RHF focus registration. Both
// record value adapters render through the one binding in `picker-field.tsx`.
it("focuses an invalid reference picker", () => {
  function Harness() {
    const form = useForm<{ reference: string | null }>({
      defaultValues: { reference: null },
    });
    return (
      <>
        <PickerField
          store="id"
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
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Validate" }));
  expect(
    screen.getByRole("combobox", { name: "Parent location" }),
  ).toHaveFocus();
});
