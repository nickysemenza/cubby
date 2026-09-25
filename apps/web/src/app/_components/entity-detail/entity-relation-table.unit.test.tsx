import { entitySummary } from "@cubby/schemas/entity-summary";
import { testShortcode } from "@cubby/schemas/testing";
import { formatCategoryLabel } from "@cubby/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createEntityMutationPort } from "~/entities/editing/use-entity-commands";
import { entityList } from "~/entities/entity-list.functions";
import {
  type EntityListInputByEntity,
  productListItem,
  taskListItem,
} from "~/entities/generated/entity-lists.gen";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";

import { categorySummaryFixture } from "../../../../tooling/product-category-fixtures";
import {
  EntityRelationTable,
  planRelationSection,
  RelationSectionActions,
} from "./entity-relation-table";

const relationSection = (entity: keyof typeof entitySummary, id: string) => {
  const section = entitySummary[entity].detail.sections.find(
    (candidate) => candidate.id === id,
  );
  if (section === undefined || section.kind !== "relation")
    throw new Error(`${entity} declares no relation section ${id}`);
  return section;
};

const planFor = (entity: keyof typeof entitySummary, id: string) =>
  // SAFETY: every fixture entity below is browser-routed.
  planRelationSection(entity as never, relationSection(entity, id));

describe("planRelationSection", () => {
  it("scopes the target list by the descriptor's field key and links Open all by its url key", () => {
    // inventory's `productId` descriptor filters through `productIdFilter`
    // on the wire but reads `productId` from the URL — the two keys differ,
    // which is exactly the drift a hand-written scope would reintroduce.
    const plan = planFor("product", "stocked-at");
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
    expect(planFor("product", "tasks").sort).toEqual({
      field: "dueDate",
      direction: "desc",
    });
    const stockedAt = planFor("product", "stocked-at");
    expect(stockedAt.sort).toEqual({ field: "createdAt", direction: "desc" });
    expect(stockedAt.limit).toBeNull();
  });

  it("offers no create button when neither the descriptor's own field nor its brandRef fallback carries a seed", () => {
    // Direct branch: `product`'s create intents carry no `purchaseId` field.
    // Fallback branch: the descriptor's `brandRef` names `purchase`, but no
    // field on `product` itself references a purchase (the relation runs the
    // other way, through Expense) — the section stays read-only rather than
    // opening a dialog that would drop the scope.
    expect(planFor("purchase", "products").seed).toBeNull();
  });

  it("uses an explicit many-reference prefill when the filter key is not writable", () => {
    // Planting's Journal section filters gardenEntry by the derived,
    // urlOnly `journalPlantingId` descriptor (direct + in-window whole-area
    // entries) — that key is not itself a create field on gardenEntry. The
    // section's explicit manifest prefill points at GardenEntry.plantingIds,
    // which the `full` create intent carries (`capture` doesn't). The create
    // dialog therefore seeds an id array rather than guessing from a filter
    // or domain-specific field name.
    const plan = planFor("planting", "garden-history");
    expect(plan.filterKey).toBe("journalPlantingId");
    expect(plan.seed).toEqual({ intent: "full", field: "plantingIds" });
    expect(plan.seedMultiple).toBe(true);
  });
});

describe("RelationSectionActions", () => {
  let harness: ReturnType<typeof createBrowserTestHarness>;
  beforeEach(() => {
    harness = createBrowserTestHarness();
  });
  afterEach(() => {
    harness.dispose();
  });

  it("renders Open all and a New trigger for the scoped target", () => {
    const plan = planFor("project", "tasks");
    render(
      <RelationSectionActions
        plan={plan}
        recordId={testShortcode("project", "PRJ-TEST")}
        title="Tasks"
      />,
      { wrapper: harness.wrapper },
    );
    expect(
      screen.getByRole("button", { name: "Open all tasks" }),
    ).toHaveAttribute(
      "href",
      "/connections?source=project&id=PRJ-TEST&view=relation%3Atasks",
    );
    // Visible text stays the generic "Add"; the accessible name carries the
    // specific noun so several sections' "Add" buttons stay distinguishable.
    const add = screen.getByRole("button", { name: "New task" });
    expect(add).toHaveTextContent("Add");
  });

  it("uses the declared createLabel as both the visible text and the name", () => {
    const plan = planFor("planting", "garden-history");
    render(
      <RelationSectionActions
        plan={plan}
        recordId={testShortcode("planting", "PLT-TEST")}
        title="Journal"
        createLabel="Log entry"
      />,
      { wrapper: harness.wrapper },
    );
    expect(
      screen.getByRole("button", { name: "Log entry" }),
    ).toBeInTheDocument();
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

  it("issues the scoped list read, sorted and filtered per the plan", async () => {
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
        plan={planFor("project", "tasks")}
        recordId={testShortcode("project", "PRJ-TEST")}
        title="Tasks"
        operations={{ list }}
      />,
      { wrapper: harness.wrapper },
    );
    await waitFor(() => expect(inputs.length).toBeGreaterThan(0));
    const [input] = inputs;
    expect(input?.entity).toBe("task");
    expect(input?.filters).toMatchObject({ projectId: "PRJ-TEST" });
    expect(input?.sort).toEqual([{ orderBy: "name", direction: "asc" }]);
  });

  it("renders the empty sentence and a create action once the read resolves empty", async () => {
    const list = entityList.list.withTransport(async () => ({
      items: [],
      meta: { pageIndex: 0, pageSize: 50, totalCount: 0, sums: {} },
    }));
    render(
      <EntityRelationTable
        plan={planFor("project", "tasks")}
        recordId={testShortcode("project", "PRJ-TEST")}
        title="Tasks"
        operations={{ list }}
      />,
      { wrapper: harness.wrapper },
    );
    expect(await screen.findByText("No tasks yet.")).toBeVisible();
    expect(
      screen.getByText("Add one and it appears here and on the tasks list."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "New task" })).toBeVisible();
  });

  it("keeps the journal's own single-line empty copy instead of the generic sentence", async () => {
    const list = entityList.list.withTransport(async () => ({
      items: [],
      meta: { pageIndex: 0, pageSize: 50, totalCount: 0, sums: {} },
    }));
    render(
      <EntityRelationTable
        plan={planFor("planting", "garden-history")}
        recordId={testShortcode("planting", "PLT-TEST")}
        title="Journal"
        emptyLabel="Nothing logged yet — the first entry starts the journal."
        operations={{ list }}
      />,
      { wrapper: harness.wrapper },
    );
    expect(
      await screen.findByText(
        "Nothing logged yet — the first entry starts the journal.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/No .* yet\./)).toBeNull();
  });

  // An embedded products table must use the same category and identifier
  // presentation as the product list, even without that page's overrides.
  it("renders product domain values without dumping structured payloads", async () => {
    const category = categorySummaryFixture("tools");
    const product = mock(productListItem, {
      seed: 3,
      overrides: { category, categoryId: category.id },
    });
    expect(product.externalIds.length).toBeGreaterThan(0);
    const list = entityList.list.withTransport(async () => ({
      items: [product],
      meta: { pageIndex: 0, pageSize: 50, totalCount: 1, sums: {} },
    }));
    render(
      <EntityRelationTable
        plan={planFor("ingredient", "products")}
        recordId={testShortcode("ingredient", "ING-TEST")}
        title="Products"
        operations={{ list }}
      />,
      { wrapper: harness.wrapper },
    );
    expect(
      await screen.findByRole("link", { name: product.name }),
    ).toBeVisible();
    const row = screen.getByRole("link", { name: product.name }).closest("tr");
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent(formatCategoryLabel(category));
    expect(row).toHaveTextContent(product.externalIds[0]!.source);
    expect(row).not.toHaveTextContent('"externalId"');
    expect(row?.querySelector("pre")).toBeNull();
  });

  // Regression: the embedded table used to build its columns with no
  // `onSaveField`, so an enum cell fell to the raw-text fallback
  // (`not_started`) and could not be edited in place, unlike the target's own
  // list page.
  it("renders an enum cell as its rich pill and saves an inline pick through the target's update", async () => {
    const task = {
      ...mock(taskListItem, { seed: 5 }),
      id: testShortcode("task", "TSK-TEST"),
      status: "not_started" as const,
    };
    const list = entityList.list.withTransport(async () => ({
      items: [task],
      meta: { pageIndex: 0, pageSize: 50, totalCount: 1, sums: {} },
    }));
    const commands: unknown[] = [];
    const mutationPort = createEntityMutationPort({
      execute: async (command) => {
        commands.push(command);
        return {
          action: "update",
          entity: "task",
          item: { ...task, status: "done" },
          sideEffects: { backgroundBatches: [] },
        };
      },
    });
    render(
      <EntityRelationTable
        plan={planFor("project", "tasks")}
        recordId={testShortcode("project", "PRJ-TEST")}
        title="Tasks"
        operations={{ list, mutationPort }}
      />,
      { wrapper: harness.wrapper },
    );
    const pill = await screen.findByText("Not started");
    expect(pill).toBeVisible();
    expect(screen.queryByText("not_started")).toBeNull();

    // Inside a table the range engine owns single clicks; double-click edits.
    fireEvent.doubleClick(pill);
    fireEvent.click(await screen.findByRole("option", { name: "Done" }));
    await waitFor(() => expect(commands).toHaveLength(1));
    expect(commands[0]).toMatchObject({
      action: "update",
      entity: "task",
      id: task.id,
      data: { status: "done" },
    });
    // The cell shows the saved pick at once; the list re-read is the root
    // MutationCache's fan-out (root-provider), outside this harness.
    expect(await screen.findByText("Done")).toBeVisible();
  });
});
