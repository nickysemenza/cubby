import {
  type ProductProjectUsesOut,
  productProjectUsesOut,
} from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { product as productOperations } from "~/app/products/product.functions";
import { project } from "~/app/projects/project.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  type ProductProjectUsesOperations,
  ProductProjectUses,
  shouldShowProductProjectUses,
} from "./product-project-uses";

const productId = testShortcode("product", "PRD-HISTORY");
const projectUse = productProjectUsesOut.parse({
  productId,
  productName: "Formerly reusable resource",
  manufacturer: "Acme",
  category: "household",
  canEdit: false,
  projectUseCount: 1,
  netLifetimeCost: 42,
  costPerProjectUse: null,
  grossLifetimeAcquisitionCost: 42,
  projects: [
    {
      projectId: testShortcode("project", "PRJ-PAST"),
      projectName: "Past kitchen repair",
      status: "done",
      kind: null,
      projectPurchaseCost: 42,
      sharedWindow: null,
      attachedAt: new Date("2026-01-01T00:00:00Z"),
    },
  ],
});

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function projectUseOperations(
  result: ProductProjectUsesOut,
): ProductProjectUsesOperations {
  return {
    // The descriptor retains parsing and cache tags; this is only the remote
    // browser boundary substituted by the UI test.
    projectUses: productOperations.projectUses.withTransport(
      async () => result,
    ),
    setProjectUses: productOperations.setProjectUses,
    setToolUsage: project.setToolUsage,
  };
}

function renderProjectUses(result: ProductProjectUsesOut) {
  return render(
    <ProductProjectUses
      productId={productId}
      operations={projectUseOperations(result)}
    />,
    { wrapper: harness.wrapper },
  );
}

describe("ProductProjectUses", () => {
  it("keeps the section available for reusable products or confirmed historical uses", () => {
    expect(shouldShowProductProjectUses("tools", 0)).toBe(true);
    expect(shouldShowProductProjectUses("software", 0)).toBe(true);
    expect(shouldShowProductProjectUses("household", 1)).toBe(true);
    expect(shouldShowProductProjectUses("household", 0)).toBe(false);
  });

  it("renders recategorized project use as read-only history", async () => {
    renderProjectUses(projectUse);

    expect(
      await screen.findByLabelText("Projects this was used on"),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Historical project use is read-only because this product is no longer a reusable resource.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Edit projects" }),
    ).not.toBeInTheDocument();
  });

  it("retains the edit affordance for current reusable resources", async () => {
    renderProjectUses({
      ...projectUse,
      category: "tools",
      canEdit: true,
    });

    expect(
      await screen.findByRole("button", { name: "Edit projects" }),
    ).toBeVisible();
    expect(
      screen.queryByText("Historical project use is read-only"),
    ).toBeNull();
  });
});
