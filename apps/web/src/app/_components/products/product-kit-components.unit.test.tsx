import { unsafeProductShortcode } from "@cubby/schemas/identifiers";
import type {
  KitMembershipOut,
  ProductComponentOut,
} from "@cubby/schemas/product-components";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  components: { current: [] as ProductComponentOut[] },
  membership: { current: [] as KitMembershipOut[] },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => ({
    data:
      options.queryKey[0] === "kitMembership"
        ? mocks.membership.current
        : options.queryKey[0] === "components"
          ? mocks.components.current
          : undefined,
    isPending: false,
  }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("~/integrations/trpc/react", () => ({
  useTRPC: () => ({
    product: {
      components: { queryOptions: () => ({ queryKey: ["components"] }) },
      kitMembership: { queryOptions: () => ({ queryKey: ["kitMembership"] }) },
      search: { queryOptions: () => ({ queryKey: ["search"] }) },
      attachComponents: { mutationOptions: vi.fn() },
      detachComponents: { mutationOptions: vi.fn() },
    },
  }),
}));
// The real link renders a hover-preview card that needs a query client; the
// name and href are all this test asserts on.
vi.mock("../EntityInlineLink", () => ({
  EntityInlineLink: ({
    entity,
    data,
  }: {
    entity: string;
    data: { id: string; name: string };
  }) => (
    <a href={`/${entity}s/${data.id}`} data-entity={entity}>
      {data.name}
    </a>
  ),
}));

import { ProductKitComponents } from "./product-kit-components";

const renderWith = (
  components: ProductComponentOut[],
  membership: KitMembershipOut[] = [],
) => {
  mocks.components.current = components;
  mocks.membership.current = membership;
  return render(<ProductKitComponents productId="PRD-KIT1" />);
};

describe("ProductKitComponents", () => {
  it("renders a kit with several components, each with its quantity", () => {
    renderWith([
      {
        productId: unsafeProductShortcode("PRD-DRIL"),
        productName: "Bare Drill",
        manufacturer: "Milwaukee",
        quantity: 1,
        price: 89,
        coverImageUrl: null,
        attachedAt: new Date("2026-01-01"),
      },
      {
        productId: unsafeProductShortcode("PRD-BATT"),
        productName: "Battery Pack",
        manufacturer: "Milwaukee",
        quantity: 2,
        price: null,
        coverImageUrl: null,
        attachedAt: new Date("2026-01-01"),
      },
    ]);

    expect(screen.getByRole("link", { name: "Bare Drill" })).toHaveAttribute(
      "href",
      "/products/PRD-DRIL",
    );
    expect(screen.getByRole("link", { name: "Battery Pack" })).toBeVisible();
    expect(screen.getByText("×1")).toBeInTheDocument();
    expect(screen.getByText("×2")).toBeInTheDocument();
    expect(screen.queryByText("Not a kit")).not.toBeInTheDocument();
    // No membership rows: this product isn't listed inside any other kit.
    expect(
      screen.queryByText("Kits this product is listed inside."),
    ).not.toBeInTheDocument();
  });

  it("shows the empty state when the product has no components", () => {
    renderWith([]);

    expect(screen.getByText("Not a kit")).toBeInTheDocument();
  });

  it("shows the kits a product is listed inside, when it's part of one", () => {
    renderWith(
      [],
      [
        {
          parentProductId: unsafeProductShortcode("PRD-COMB"),
          parentProductName: "18V Combo Kit",
          manufacturer: "Milwaukee",
          quantity: 2,
          attachedAt: new Date("2026-01-01"),
        },
      ],
    );

    expect(
      screen.getByText("Kits this product is listed inside."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "18V Combo Kit" })).toHaveAttribute(
      "href",
      "/products/PRD-COMB",
    );
    expect(screen.getByText("×2")).toBeInTheDocument();
  });
});
