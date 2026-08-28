import { locationSuggestionSchema } from "@cubby/schemas/ai";
import type {
  LocationShortcode,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { ai } from "~/lib/ai.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  type LocationFieldWithAIOperations,
  LocationFieldWithAI,
} from "./location-field-with-ai";

type LocationFormValues = {
  location: ComboboxItem<LocationShortcode> | null;
};

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function Harness({
  operations,
}: {
  operations: LocationFieldWithAIOperations;
}) {
  const form = useForm<LocationFormValues>({
    defaultValues: { location: null },
  });
  return (
    <LocationFieldWithAI
      form={form}
      name="location"
      productId={testShortcode("product", "PRD-4K7M")}
      operations={operations}
      acceptLocation={(location) => form.setValue("location", location)}
    />
  );
}

const suggestedLocation = locationSuggestionSchema.parse({
  location: {
    id: "LOC-2222",
    name: "PACKOUT Wall",
    type: "shelf",
    ancestors: [{ id: "LOC-AAAA", name: "Garage", type: "room" }],
  },
  confidence: "high",
  reasoning: "Three M18 siblings already live there.",
});

describe("LocationFieldWithAI", () => {
  it("keeps the field unchanged until the real suggestion operation is accepted", async () => {
    const requests: ProductShortcode[] = [];
    const operations = {
      suggestLocation: ai.suggestLocation.withTransport(async ({ input }) => {
        requests.push(input.productId);
        return suggestedLocation;
      }),
    } satisfies LocationFieldWithAIOperations;

    render(<Harness operations={operations} />, { wrapper: harness.wrapper });

    const picker = screen.getByRole("combobox", { name: "location" });
    expect(picker).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: /suggest/i }));

    await waitFor(() => {
      expect(
        screen.getByText("Three M18 siblings already live there."),
      ).toBeInTheDocument();
    });
    expect(picker).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(picker).toHaveValue("PACKOUT Wall — shelf"));
    expect(requests).toEqual([testShortcode("product", "PRD-4K7M")]);
  });

  it("keeps the picker empty when the operation rejects", async () => {
    const operations = {
      suggestLocation: ai.suggestLocation.withTransport(async () => {
        throw new Error("gateway down");
      }),
    } satisfies LocationFieldWithAIOperations;

    render(<Harness operations={operations} />, { wrapper: harness.wrapper });
    const picker = screen.getByRole("combobox", { name: "location" });
    fireEvent.click(screen.getByRole("button", { name: /suggest/i }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    });
    expect(picker).toHaveValue("");
  });
});
