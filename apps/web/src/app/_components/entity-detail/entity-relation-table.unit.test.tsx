import { entitySummary } from "@cubby/schemas/entity-summary";
import { testShortcode } from "@cubby/schemas/testing";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { entityList } from "~/entities/entity-list.functions";
import {
  type EntityListInputByEntity,
  productListItem,
} from "~/entities/generated/entity-lists.gen";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";

import {
  EntityRelationTable,
  planRelationSection,
} from "./entity-relation-table";

const relationSection = (entity: keyof typeof entitySummary, id: string) => {
  const section = entitySummary[entity].detail.sections.find(
    (candidate) => candidate.id === id,
  );
  if (section === undefined || section.kind !== "relation")
    throw new Error(`${entity} declares no relation section ${id}`);
  return section;
};

describe("planRelationSection", () => {
  it("scopes the target list by the descriptor's field key and links Open all by its url key", () => {
    // inventory's `productId` descriptor filters through `productIdFilter`
    // on the wire but reads `productId` from the URL — the two keys differ,
    // which is exactly the drift a hand-written scope would reintroduce.
    const plan = planRelationSection(
      "product",
      relationSection("product", "stocked-at"),
    );
    expect(plan).toMatchObject({
      target: "inventory",
      filterKey: "productIdFilter",
      urlKey: "productId",
      columns: ["amount", "placement", "verifiedAt"],
    });
    // The create button prefills the real field, not the filter alias.
    expect(plan.seed).toEqual({ intent: "capture", field: "productId" });
  });

  it("honours the declared sort and limit, and falls back to the target's default sort", () => {
    // The product tasks relation is where the old client-side "open work
    // first" ordering lived; the declaration now owns it as `dueDate desc`.
    expect(
      planRelationSection("product", relationSection("product", "tasks")).sort,
    ).toEqual({ field: "dueDate", direction: "desc" });
    const stockedAt = planRelationSection(
      "product",
      relationSection("product", "stocked-at"),
    );
    expect(stockedAt.sort).toEqual({ field: "createdAt", direction: "desc" });
    expect(stockedAt.limit).toBeNull();
  });

  it("offers no create button when no create intent of the target carries the seed field", () => {
    // A product cannot be captured "for a purchase"; the section stays
    // read-only rather than opening a dialog that would drop the scope.
    const plan = planRelationSection(
      "purchase",
      relationSection("purchase", "products"),
    );
    expect(plan.seed).toBeNull();
  });

  it("picks the first create intent that can be seeded, not only the default one", () => {
    // gardenEntry's `capture` intent has no `plantingId`; `full` does — the
    // journal's "Log entry" button depends on falling through to it.
    const plan = planRelationSection(
      "planting",
      relationSection("planting", "garden-history"),
    );
    expect(plan.seed).toEqual({ intent: "full", field: "plantingId" });
  });
});

describe("EntityRelationTable", () => {
  let harness: ReturnType<typeof createBrowserTestHarness>;
  beforeEach(() => {
    harness = createBrowserTestHarness();
  });
  afterEach(() => {
    harness.dispose();
  });

  it("issues the scoped list read and renders the header affordances", async () => {
    const inputs: EntityListInputByEntity["task"][] = [];
    const list = entityList.list.withTransport(async ({ input }) => {
      // SAFETY: the test only mounts the project → tasks relation.
      inputs.push(input as EntityListInputByEntity["task"]);
      return {
        items: [],
        meta: { pageIndex: 0, pageSize: 50, totalCount: 0, sums: {} },
      };
    });
    render(
      <EntityRelationTable
        entity="project"
        section={relationSection("project", "tasks")}
        recordId={testShortcode("project", "PRJ-TEST")}
        operations={{ list }}
      />,
      { wrapper: harness.wrapper },
    );
    // The link renders through the button primitive, hence the button role.
    expect(
      screen.getByRole("button", { name: "Open all tasks" }),
    ).toHaveAttribute("href", "/tasks?project=PRJ-TEST");
    expect(
      screen.getByRole("button", { name: "New task" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(inputs.length).toBeGreaterThan(0));
    const [input] = inputs;
    expect(input?.entity).toBe("task");
    expect(input?.filters).toMatchObject({ projectId: "PRJ-TEST" });
    expect(input?.sort).toEqual([{ orderBy: "createdAt", direction: "desc" }]);
  });

  // Regression: an ingredient's products section crashed on a product row
  // because `externalIds` is a `text-array` kind whose list read is an array
  // of objects; the generic cell now renders it as readable JSON.
  it("renders a target row whose text-array field carries structured values", async () => {
    const product = mock(productListItem, { seed: 3 });
    expect(product.externalIds.length).toBeGreaterThan(0);
    const list = entityList.list.withTransport(async () => ({
      items: [product],
      meta: { pageIndex: 0, pageSize: 50, totalCount: 1, sums: {} },
    }));
    render(
      <EntityRelationTable
        entity="ingredient"
        section={relationSection("ingredient", "products")}
        recordId={testShortcode("ingredient", "ING-TEST")}
        operations={{ list }}
      />,
      { wrapper: harness.wrapper },
    );
    expect(
      await screen.findByRole("link", { name: product.name }),
    ).toBeVisible();
  });
});
