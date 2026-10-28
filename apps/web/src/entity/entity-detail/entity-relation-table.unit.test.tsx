import { entitySummary } from "@cubby/schemas/entity-summary";
import {
  purchaseProductOut,
  productPurchaseOut,
} from "@cubby/schemas/purchase";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createEditorBrowserTestHarness as createBrowserTestHarness,
  createEditorTestQueryClient,
} from "#web/tests/editor-metadata.fixtures.ts";
import { createEntityMutationPort } from "~/entity/editing/use-entity-commands";
import type { EntityListInputByEntity } from "~/entity/generated/entity-lists.gen";
import { installFeatures } from "~/features/registry";
import { entityGraph } from "~/integrations/tanstack-query/domains/entityGraph";
import { entityList } from "~/integrations/tanstack-query/domains/entityList";
import { mock } from "~/lib/test/mock-schema";
import { getEntityListItemSchema } from "~/server/entity-reads/list-contracts";
const productListItem = getEntityListItemSchema("product");
const purchaseListItem = getEntityListItemSchema("purchase");
const taskListItem = getEntityListItemSchema("task");

import {
  EntityRelationTable,
  planRelationSection,
  RelationSectionActions,
} from "./entity-relation-table";

installFeatures();
const queryClient = createEditorTestQueryClient();

const relationSection = (entity: keyof typeof entitySummary, id: string) => {
  const section = entitySummary[entity].detail.sections.find(
    (candidate) => candidate.id === id,
  );
  if (section === undefined || section.kind !== "relation")
    throw new Error(`${entity} declares no relation section ${id}`);
  return section;
};

const planFor = (entity: keyof typeof entitySummary, id: string) =>
  planRelationSection(queryClient, entity, relationSection(entity, id));

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
      columns: ["amount", "placement", "ownerLedgerPartyId", "verifiedAt"],
    });
    // The create button prefills the real field, not the filter alias.
    expect(plan.seed).toMatchObject({ intent: "capture", field: "productId" });
    expect(plan.seed?.fields).toContain("productId");
    expect(plan.pageSize).toBe(50);
  });

  it("switches off a hierarchical filter's subtree toggle for the direct relation", () => {
    // A project's Tasks section follows the task's own project, not the
    // generated default-on "Include sub-projects" expansion.
    expect(planFor("project", "tasks").subtree).toBe("includeSubProjects");
    expect(planFor("product", "stocked-at").subtree).toBeNull();
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
    // Planting's Journal section filters gardenEntry by the derived
    // `journalPlantingId` descriptor (direct + in-window whole-area
    // entries) — that key is not itself a create field on gardenEntry. The
    // section's explicit manifest prefill points at GardenEntry.plantingIds,
    // which the `full` create intent carries (`capture` doesn't). The create
    // dialog therefore seeds an id array rather than guessing from a filter
    // or domain-specific field name.
    const plan = planFor("planting", "garden-history");
    expect(plan.filterKey).toBe("journalPlantingId");
    expect(plan.seed).toMatchObject({ intent: "full", field: "plantingIds" });
    expect(plan.seed?.fields).toContain("plantingIds");
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

  it("server-renders its loading boundary while the relation's first page is pending", () => {
    const read = vi.fn(async () => new Promise<never>(() => {}));
    const list = entityList.list.withTransport(read);
    const Wrapper = harness.wrapper;
    const html = renderToString(
      <Wrapper>
        <EntityRelationTable
          plan={planFor("project", "tasks")}
          recordId={testShortcode("project", "PRJ-TEST")}
          title="Tasks"
          operations={{ list }}
        />
      </Wrapper>,
    );
    expect(read).toHaveBeenCalledOnce();
    expect(html).toContain('aria-busy="true"');
  });

  // Late metadata must update cells without replacing target list rows, and
  // planned money cannot become an acquisition through client classification.
  it("shows server movement and planning evidence on purchase product rows", async () => {
    const rows = [1, 2, 3].map((seed) =>
      mock(productListItem, {
        seed,
        overrides: {
          name: `Role item ${seed}`,
          id: testShortcode("product", `PRD-RL${seed}A`),
        },
      }),
    );
    const list = entityList.list.withTransport(async () => ({
      items: rows,
      meta: {
        hasNextPage: false,
        pageIndex: 0,
        pageSize: 50,
        totalCount: 3,
        sums: {},
      },
    }));
    let reads = 0;
    const relation = entityGraph.relation.withTransport(async ({ input }) => {
      expect(input.targetIds).toEqual(rows.map((row) => row.id).sort());
      expect(input.limit).toBe(50);
      reads += 1;
      return {
        entity: "purchase",
        relation: "products",
        id: "PUR-ROLE",
        totalCount: rows.length,
        items: rows.map((row, index) =>
          mock(purchaseProductOut, {
            seed: index,
            overrides: {
              productId: row.id,
              source: index === 1 ? "link" : "expense",
              movementKinds:
                index === 0 ? ["acquired", "adjusted", "exited"] : [],
              hasPlanned: index !== 1,
            },
          }),
        ),
      };
    });
    render(
      <EntityRelationTable
        plan={planFor("purchase", "products")}
        recordId={testShortcode("purchase", "PUR-ROLE")}
        title="Products"
        operations={{ list, relation }}
      />,
      { wrapper: harness.wrapper },
    );
    const first = (
      await screen.findByRole("link", { name: "Role item 1" })
    ).closest("tr");
    await waitFor(() => expect(first).toHaveTextContent("Acquired"));
    expect(first).toHaveTextContent("Price adjusted");
    expect(first).toHaveTextContent("Exited");
    expect(first).toHaveTextContent("Planned");
    const linked = screen
      .getByRole("link", { name: "Role item 2" })
      .closest("tr");
    expect(linked).toHaveTextContent("Linked");
    expect(linked).not.toHaveTextContent("Acquired");
    const planned = screen
      .getByRole("link", { name: "Role item 3" })
      .closest("tr");
    expect(planned).toHaveTextContent("Planned");
    expect(planned).not.toHaveTextContent("Acquired");
    expect(reads).toBe(1);
  });

  it("shows the same movement evidence on inverse product purchase rows", async () => {
    const row = mock(purchaseListItem, {
      seed: 11,
      overrides: {
        id: testShortcode("purchase", "PUR-RLAA"),
        displayLabel: "Role order",
      },
    });
    const list = entityList.list.withTransport(async () => ({
      items: [row],
      meta: {
        hasNextPage: false,
        pageIndex: 0,
        pageSize: 50,
        totalCount: 1,
        sums: {},
      },
    }));
    const relation = entityGraph.relation.withTransport(async () => ({
      entity: "product",
      relation: "purchases",
      id: "PRD-ROLE",
      totalCount: 1,
      items: [
        mock(productPurchaseOut, {
          seed: 11,
          overrides: {
            purchaseId: row.id,
            source: "expense",
            movementKinds: ["discarded", "unknown"],
            hasPlanned: false,
          },
        }),
      ],
    }));
    render(
      <EntityRelationTable
        plan={planFor("product", "purchases")}
        recordId={testShortcode("product", "PRD-ROLE")}
        title="Related orders"
        operations={{ list, relation }}
      />,
      { wrapper: harness.wrapper },
    );
    expect(await screen.findByText("Discarded")).toBeVisible();
    expect(screen.getByText("Unknown movement")).toBeVisible();
  });

  it("issues the scoped list read, sorted, grouped and filtered per the plan", async () => {
    const inputs: EntityListInputByEntity["task"][] = [];
    const list = entityList.list.withTransport(async ({ input }) => {
      inputs.push(input as EntityListInputByEntity["task"]);
      return {
        items: [],
        meta: {
          hasNextPage: false,
          pageIndex: 0,
          pageSize: 50,
          totalCount: 0,
          sums: {},
        },
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
    // Project → Tasks declares status grouping and newest-due-first order.
    expect(input?.sort).toEqual([{ orderBy: "dueDate", direction: "desc" }]);
    expect(input).toMatchObject({ groupBy: [{ key: "status" }] });
  });

  it("hides the column that names the record the section belongs to", () => {
    expect(planFor("project", "tasks").backReferenceColumn).toBe("projectId");
  });

  it("keeps the journal's own single-line empty copy instead of the generic sentence", async () => {
    const list = entityList.list.withTransport(async () => ({
      items: [],
      meta: {
        hasNextPage: false,
        pageIndex: 0,
        pageSize: 50,
        totalCount: 0,
        sums: {},
      },
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
      meta: {
        hasNextPage: false,
        pageIndex: 0,
        pageSize: 50,
        totalCount: 1,
        sums: {},
      },
    }));
    const commands: unknown[] = [];
    const mutationPort = createEntityMutationPort({
      execute: async (command) => {
        commands.push(command);
        return {
          action: "update",
          entity: "task",
          item: { id: task.id, status: "done" },
          appliedFields: ["status"],
          sideEffects: {},
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
    // This injected cache runtime does not reconcile receipts; canonical row
    // publication is covered through the real root MutationCache.
    expect(await screen.findByText("Not started")).toBeVisible();
  });
});
