import type { CollectionMatrixOut } from "@cubby/schemas/collection";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { CollectionAssignmentMatrix } from "./collection-assignment-matrix";
import type { CollectionAssignmentSearch } from "./collection-assignment-search";
import { collection } from "./collection.functions";

const baseMatrix: CollectionMatrixOut = {
  collections: ["painting", "kitchen"],
  rows: [
    {
      id: "PRD-PA77",
      name: "Primer",
      secondary: "Example paint",
      imageUrl: null,
      placements: [],
      purchases: [],
      states: { painting: "direct", kitchen: "inherited" },
    },
  ],
  totalCount: 1,
};

let matrixData: CollectionMatrixOut = baseMatrix;
let matrixError: Error | null = null;
let matrixRequests = 0;
const searchChanges: CollectionAssignmentSearch[] = [];

// The production catalog and schemas stay in use. This adapter is only the
// remote behavior the browser cannot provide in a UI test.
const testOperations = {
  matrix: collection.matrix.withTransport(async () => {
    matrixRequests += 1;
    if (matrixError) throw matrixError;
    return matrixData;
  }),
  set: collection.set.withTransport(async () => ({
    collection: "painting",
    assigned: true,
  })),
  create: collection.create.withTransport(async () => ({
    slug: "painting",
    productCount: 1,
    rootLocationCount: 0,
  })),
};

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  matrixData = baseMatrix;
  matrixError = null;
  matrixRequests = 0;
  searchChanges.length = 0;
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function renderMatrix() {
  return render(
    <CollectionAssignmentMatrix
      subject="product"
      page={1}
      pageSize={100}
      sort="name-asc"
      onSearchChange={(next) => searchChanges.push(next)}
      operations={testOperations}
    />,
    { wrapper: harness.wrapper },
  );
}

async function mobileRows() {
  const section = (
    await screen.findByRole("heading", { name: "Products" })
  ).closest("section");
  if (!section) throw new Error("Expected the mobile assignment rows section");
  return within(section);
}

describe("CollectionAssignmentMatrix mobile projection", () => {
  it("keeps a phone assignment target separate from the matrix filter", async () => {
    renderMatrix();

    await screen.findByRole("combobox", { name: "Assign to Collection" });
    const collectionTarget = screen.getByRole("combobox", {
      name: "Assign to Collection",
    });
    expect(collectionTarget).toHaveValue("painting");
    const mobile = await mobileRows();
    expect(
      mobile.getByRole("button", {
        name: "Remove direct Painting assignment for Primer",
      }),
    ).toBeVisible();

    fireEvent.change(collectionTarget, { target: { value: "kitchen" } });

    expect(collectionTarget).toHaveValue("kitchen");
    expect(
      mobile.getByRole("button", {
        name: "Add direct Kitchen assignment for Primer; inherited membership remains",
      }),
    ).toBeVisible();
    expect(searchChanges).toEqual([]);
  });

  it("optimistically changes a direct assignment on the selected target", async () => {
    renderMatrix();

    const mobile = await mobileRows();
    const assignment = mobile.getByRole("button", {
      name: "Remove direct Painting assignment for Primer",
    });
    fireEvent.click(assignment);

    expect(assignment).toHaveAttribute("aria-pressed", "false");
    expect(assignment).toHaveTextContent("Assign");
  });

  it("keeps a thumb-sized detail link beside the assignment control", async () => {
    renderMatrix();

    const mobile = await mobileRows();
    expect(mobile.getByRole("link", { name: "Primer" })).toHaveClass(
      "min-h-11",
    );
  });

  it("keeps the mobile subject selector and valid creation path when empty", async () => {
    matrixData = { ...baseMatrix, collections: [] };

    renderMatrix();

    expect(
      await screen.findByRole("combobox", { name: "Assignment subject" }),
    ).toHaveValue("product");
    expect(screen.getByText("No Collections yet")).toBeVisible();
    expect(
      screen
        .getAllByRole("button", { name: "New Collection" })
        .some((button) => !button.hasAttribute("disabled")),
    ).toBe(true);
  });

  it("keeps the phone ledger to 25 rows while paging within the fetched batch", async () => {
    matrixData = {
      collections: ["painting"],
      rows: Array.from({ length: 26 }, (_, index) => ({
        id: `PRD-P${String(index + 10).padStart(3, "0")}`,
        name: `Product ${index + 1}`,
        secondary: "Example paint",
        imageUrl: null,
        placements: [],
        purchases: [],
        states: { painting: "empty" },
      })),
      totalCount: 26,
    };

    renderMatrix();

    const mobile = await mobileRows();
    expect(mobile.getByText("Product 25")).toBeVisible();
    expect(mobile.queryByText("Product 26")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByLabelText("Next 25 assignments", { selector: "button" }),
    );

    expect(await mobile.findByText("Product 26")).toBeVisible();
    expect(searchChanges).toEqual([]);
  });

  it("distinguishes a failed matrix load and offers retry", async () => {
    matrixError = new Error("Collection service unavailable");

    renderMatrix();

    await waitFor(() =>
      expect(screen.getAllByText("Couldn’t load assignments")).toHaveLength(2),
    );
    expect(screen.getAllByText("Collection service unavailable")).toHaveLength(
      2,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]!);
    await waitFor(() => expect(matrixRequests).toBe(2));
  });
});
