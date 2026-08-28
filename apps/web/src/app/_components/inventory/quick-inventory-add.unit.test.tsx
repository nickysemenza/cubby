import { testShortcode } from "@cubby/schemas/testing";
/**
 * The unit default has to survive all the way to the mutation, not just sit in
 * `defaultValues`: `amount` requires `unit: z.string().min(1)`, so an empty
 * default means zodResolver blocks the first submit and nothing is called at
 * all. That failure is invisible to a test that only reads the field.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  type QuickInventoryOperations,
  QuickInventoryAdd,
} from "./quick-inventory-add";

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

describe("QuickInventoryAdd", () => {
  it("submits 1 each without the operator typing a unit", async () => {
    const requests: Parameters<
      QuickInventoryOperations["createInventory"]
    >[0][] = [];
    const operations = {
      createInventory: async (input) => {
        requests.push(input);
      },
    } satisfies QuickInventoryOperations;
    const { container } = render(
      <QuickInventoryAdd
        locationId={testShortcode("location", "LOC-2222")}
        onSuccess={() => undefined}
        operations={operations}
        initialProduct={{
          id: testShortcode("product", "PRD-4K7M"),
          name: "Source Drill",
        }}
      />,
      { wrapper: harness.wrapper },
    );

    expect(screen.getByLabelText("Amount Unit")).toHaveValue("each");

    const form = container.querySelector("form");
    if (!form) throw new Error("no form rendered");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(requests).toEqual([
        {
          productId: "PRD-4K7M",
          locationId: "LOC-2222",
          amount: { value: 1, unit: "each" },
        },
      ]);
    });
  });
});
