/**
 * The unit default has to survive all the way to the mutation, not just sit in
 * `defaultValues`: `amount` requires `unit: z.string().min(1)`, so an empty
 * default means zodResolver blocks the first submit and nothing is called at
 * all. That failure is invisible to a test that only reads the field.
 */

import {
  unsafeLocationShortcode,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { QuickInventoryAdd } from "./quick-inventory-add";

const mocks = vi.hoisted(() => ({
  mutateAsync: vi.fn().mockResolvedValue({}),
}));

vi.mock("~/integrations/trpc/react", () => ({
  useTRPC: () => ({
    product: {
      create: { mutationOptions: () => ({ mutationFn: async () => ({}) }) },
    },
  }),
}));
vi.mock("./hooks", () => ({
  useCreateInventoryMutation: () => ({
    mutateAsync: mocks.mutateAsync,
    isPending: false,
  }),
  useProductLookupInvalidation: () => vi.fn(),
  useUpcLookup: () => ({}),
}));
vi.mock("../combobox/with-search-hook", () => {
  // Every wrapper renders its children with an empty, settled result set: the
  // pickers are not what this test is about, but `product-form-fields` imports
  // the whole map, so a partial mock breaks the module.
  const passthrough = ({
    children,
  }: {
    children: (props: {
      items: never[];
      onSearchChange: () => void;
      isLoading: boolean;
      onOpenChange: () => void;
    }) => ReactNode;
  }) =>
    children({
      items: [],
      onSearchChange: () => {},
      isLoading: false,
      onOpenChange: () => {},
    });
  return {
    WithIngredientSearch: passthrough,
    WithLocationSearch: passthrough,
    WithProductSearch: passthrough,
    WithRecipeSearch: passthrough,
  };
});
vi.mock("~/hooks/useImageState", () => ({
  useImageState: () => ({ reset: vi.fn() }),
}));
vi.mock("../products/use-upc-aware-create", () => ({
  useUpcAwareCreate: () => ({ onCreateNew: vi.fn(), handleCreateNew: vi.fn() }),
}));

describe("QuickInventoryAdd", () => {
  it("submits 1 each without the operator typing a unit", async () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <QuickInventoryAdd
          locationId={unsafeLocationShortcode("LOC-2222")}
          onSuccess={vi.fn()}
          initialProduct={{
            id: unsafeProductShortcode("PRD-4K7M"),
            name: "Source Drill",
          }}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByLabelText("Amount Unit")).toHaveValue("each");

    const form = container.querySelector("form");
    if (!form) throw new Error("no form rendered");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mocks.mutateAsync).toHaveBeenCalledWith({
        productId: "PRD-4K7M",
        locationId: "LOC-2222",
        amount: { value: 1, unit: "each" },
      });
    });
  });
});
