import { unsafeProductShortcode } from "@cubby/schemas/identifiers";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import { LocationFieldWithAI } from "./location-field-with-ai";

const mocks = vi.hoisted(() => ({
  suggestLocation: vi.fn(),
}));

vi.mock("~/integrations/trpc/react", () => ({
  useTRPCClient: () => ({
    ai: { suggestLocation: { query: mocks.suggestLocation } },
  }),
}));

// The real combobox pulls the whole location roster over tRPC; this stands in
// for it as a readout of the form value, which is what the suggestion writes.
vi.mock("~/app/_components/form-utils/combobox-field-with-search", () => ({
  ComboboxFieldWithSearch: ({
    form,
    name,
  }: {
    form: { watch: (n: string) => { id: string; name: string } | null };
    name: string;
  }) => <div data-testid="combobox">{form.watch(name)?.name ?? "(empty)"}</div>,
}));

function Harness() {
  const form = useForm<{ location: { id: string; name: string } | null }>({
    defaultValues: { location: null },
  });
  return (
    <LocationFieldWithAI
      form={form}
      name="location"
      productId={unsafeProductShortcode("PRD-4K7M")}
    />
  );
}

describe("LocationFieldWithAI", () => {
  it("writes the suggested location into the field and shows its reasoning", async () => {
    mocks.suggestLocation.mockResolvedValue({
      location: { id: "LOC-2222", name: "PACKOUT Wall" },
      confidence: "high",
      reasoning: "Three M18 siblings already live there.",
    });

    render(<Harness />);
    expect(screen.getByTestId("combobox")).toHaveTextContent("(empty)");

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByTestId("combobox")).toHaveTextContent("PACKOUT Wall");
    });
    expect(mocks.suggestLocation).toHaveBeenCalledWith({
      productId: "PRD-4K7M",
    });
    expect(
      screen.getByText("Three M18 siblings already live there."),
    ).toBeInTheDocument();
    expect(screen.getByText("high confidence")).toBeInTheDocument();
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
