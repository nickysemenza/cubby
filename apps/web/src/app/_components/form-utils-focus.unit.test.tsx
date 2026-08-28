import { fireEvent, render, screen } from "@testing-library/react";
import { useForm, type UseFormReturn } from "react-hook-form";
import { describe, expect, it } from "vitest";

import { UnifiedTextField } from "./form-utils";

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
