import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";

import { LocationFieldWithAI } from "./location-field-with-ai";

const mocks = vi.hoisted(() => ({
  suggestLocation: vi.fn(),
}));

vi.mock("~/lib/ai.functions", () => ({
  ai: {
    suggestLocation: { call: mocks.suggestLocation },
  },
}));

// The real combobox pulls the whole location roster over a Start function; this stands in
// for it as a readout of the form value, which is what the suggestion writes.
vi.mock("~/app/_components/form-utils/combobox-field-with-search", () => ({
  ComboboxFieldWithSearch: ({
    form,
    name,
  }: {
    form: {
      watch: (n: string) => { name: string; detail?: string } | null;
    };
    name: string;
  }) => {
    const item = form.watch(name);
    return (
      <div data-testid="combobox">
        {item ? `${item.detail ?? ""}|${item.name}` : "(empty)"}
      </div>
    );
  },
}));

function Harness() {
  const form = useForm<{ location: { id: string; name: string } | null }>({
    defaultValues: { location: null },
  });
  return (
    <LocationFieldWithAI
      form={form}
      name="location"
      productId={testShortcode("product", "PRD-4K7M")}
    />
  );
}

describe("LocationFieldWithAI", () => {
  it("keeps the field unchanged until the suggestion is accepted", async () => {
    mocks.suggestLocation.mockResolvedValue({
      location: {
        id: "LOC-2222",
        name: "PACKOUT Wall",
        type: "shelf",
        ancestors: [{ id: "LOC-AAAA", name: "Garage", type: "room" }],
      },
      confidence: "high",
      reasoning: "Three M18 siblings already live there.",
    });

    render(<Harness />);
    expect(screen.getByTestId("combobox")).toHaveTextContent("(empty)");

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(
        screen.getByText("Three M18 siblings already live there."),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("combobox")).toHaveTextContent("(empty)");
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    // The breadcrumb rides along, so the accepted pick is as legible as one
    // chosen by hand.
    expect(screen.getByTestId("combobox")).toHaveTextContent(
      "Garage|PACKOUT Wall",
    );
    expect(mocks.suggestLocation).toHaveBeenCalledWith({
      productId: "PRD-4K7M",
    });
  });

  it("leaves the field alone when the suggestion fails", async () => {
    mocks.suggestLocation.mockRejectedValue(new Error("gateway down"));

    render(<Harness />);
    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(mocks.suggestLocation).toHaveBeenCalled();
    });
    expect(screen.getByTestId("combobox")).toHaveTextContent("(empty)");
  });
});
