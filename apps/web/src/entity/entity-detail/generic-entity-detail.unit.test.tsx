import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { imageWithEntitySchema } from "@cubby/schemas/image";
import { cookbookSummary } from "@cubby/schemas/recipe";
import { runOut } from "@cubby/schemas/run";
import { testShortcode } from "@cubby/schemas/testing";
import { TIER1_NUTRIENT_KEYS } from "@cubby/usda";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  detailEntities,
  getEntityDetailOutputSchema,
} from "~/entity/generated/entity-details.gen";
import { inventoryListItem } from "~/entity/generated/entity-lists.gen";
import {
  entityList,
  entityTimeline,
} from "~/integrations/tanstack-query/generated/catalog.gen";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";

import { categorySummaryFixture } from "../../../tooling/product-category-fixtures";
import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";
import { GenericEntityDetail } from "./generic-entity-detail";

const genericDetailEntities: readonly GenericDetailEntity[] = [
  ...detailEntities,
  "image",
  "cookbook",
  "run",
];

const pending = { status: "pending", reason: "totals_missing" } as const;
const emptyTotals = {
  cost: pending,
  nutrition: Object.fromEntries(
    TIER1_NUTRIENT_KEYS.map((key) => [key, pending]),
  ),
  macros: {
    calories: pending,
    protein: pending,
    carbs: pending,
    fat: pending,
    partial: false,
  },
};

/**
 * The generator cannot satisfy a few cross-field refinements (external-id
 * slugs, nutrition coverage); those fields are pinned to their empty shapes.
 * Attachment and Product gallery collections stay empty under jsdom.
 */
const fixtureOverrides = {
  product: { externalIds: [], attachments: [], images: [], labelImages: [] },
  ingredient: { product: [], attachments: [] },
  inventory: { product: { externalIds: [] }, attachments: [] },
  meal: { recipes: [], totals: emptyTotals, attachments: [] },
  recipe: { totals: emptyTotals, attachments: [] },
  financialTransaction: {
    status: "posted",
    postedDate: "2026-09-21",
    attachments: [],
  },
  // Candidate rows hydrate product images over the transport; none here.
  wish: { candidates: [], attachments: [] },
} as const;
const NO_ATTACHMENTS = { attachments: [] } as const;

/** A schema-valid detail record for any generic detail entity. */
function recordFor<E extends GenericDetailEntity>(
  entity: E,
): DetailRecordOf<E> {
  const seed = 7;
  const overrides = Object.hasOwn(fixtureOverrides, entity)
    ? fixtureOverrides[entity as keyof typeof fixtureOverrides]
    : NO_ATTACHMENTS;
  const schema =
    entity === "image"
      ? imageWithEntitySchema
      : entity === "cookbook"
        ? cookbookSummary
        : entity === "run"
          ? runOut
          : getEntityDetailOutputSchema(entity as never);
  return mock(schema, {
    seed,
    overrides: overrides as never,
  }) as DetailRecordOf<E>;
}

// Relation tables and timeline sections read through the transport; canned
// empty reads keep the page's structure under test without a server.
const operations = {
  list: {
    list: entityList.list.withTransport(async () => ({
      items: [],
      meta: { pageIndex: 0, pageSize: 50, totalCount: 0, sums: {} },
    })),
  },
  timeline: {
    timeline: entityTimeline.timeline.withTransport(async () => ({
      groups: [],
      stats: [],
      notes: [],
      meta: { totalCount: 0, pageIndex: 0, pageSize: 200 },
    })),
  },
};

describe("GenericEntityDetail", () => {
  let harness: ReturnType<typeof createBrowserTestHarness>;
  beforeEach(() => {
    harness = createBrowserTestHarness();
  });
  afterEach(() => {
    cleanup();
    harness.dispose();
  });

  // Table-driven over the manifest: every declared fields/relation/timeline
  // section renders under its declared id and title, so a declaration the
  // page silently drops fails here rather than in the browser. Slot sections
  // are registry-dependent and covered by their own `applies` predicates. A
  const cases = genericDetailEntities.flatMap((entity) =>
    entitySummary[entity].detail.sections
      .filter((section) => section.kind !== "slot")
      .map((section) => ({ entity, section })),
  );

  it.each(cases)(
    "$entity renders the declared $section.kind section $section.id",
    async ({ entity, section }) => {
      await harness.router.navigate({ to: "/", hash: section.id });
      const { container } = render(
        <GenericEntityDetail
          entity={entity}
          record={recordFor(entity)}
          operations={operations}
        />,
        { wrapper: harness.wrapper },
      );
      const element = container.querySelector(`section#${section.id}`);
      if (!(element instanceof HTMLElement))
        throw new Error(`${entity} did not render section ${section.id}`);
      expect(
        within(element).getByRole("heading", { level: 3 }),
      ).toHaveTextContent(section.title ?? "");
    },
  );

  // AI runs had no page before Run moved onto the generic detail: the
  // purchase-import page scoped to a member party. Their page must show what
  // they did (AI usage, changes) and none of the import workflow.
  it("gives an AI run its usage and changes but no import workflow", async () => {
    await harness.router.navigate({ to: "/", hash: "evidence" });
    render(
      <GenericEntityDetail
        entity="run"
        record={{ ...recordFor("run"), purpose: "ai_suggest" }}
        operations={operations}
      />,
      { wrapper: harness.wrapper },
    );
    const titles = screen
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    expect(titles).toEqual(expect.arrayContaining(["AI usage", "Changes"]));
    expect(titles).not.toContain("Import");
    expect(titles).not.toContain("Photos");
  });

  it("links a reference field to its target's detail route", () => {
    const record = recordFor("task");
    // SAFETY: `testShortcode` mints a valid project shortcode.
    const projectId = testShortcode("project", "PRJ-DECK");
    const linked = { ...record, projectId, projectName: "Deck rebuild" };
    render(
      <GenericEntityDetail
        entity="task"
        record={linked}
        operations={operations}
      />,
      {
        wrapper: harness.wrapper,
      },
    );
    expect(screen.getByRole("link", { name: "Deck rebuild" })).toHaveAttribute(
      "href",
      `/projects/${projectId}`,
    );
  });

  // Regression: the hero chip read only static `control.options`, so a task
  // (whose status labels live in the rich option table) stamped the raw
  // `not_started` on its own page while every other surface said "Not started".
  it("stamps the hero chip with the enum's rich label", () => {
    const record = { ...recordFor("task"), status: "not_started" as const };
    render(
      <GenericEntityDetail
        entity="task"
        record={record}
        operations={operations}
      />,
      { wrapper: harness.wrapper },
    );
    expect(screen.getAllByText("Not started").length).toBeGreaterThan(0);
    expect(screen.queryByText("not_started")).toBeNull();
  });

  // Regression: `externalIds` is a `text-array` field whose read shape is an
  // array of objects; deriving its cohort link used to parse it as strings
  // and crash the whole product page.
  it("renders a product whose external ids are structured records", () => {
    const product = mock(getEntityDetailOutputSchema("product"), {
      seed: 11,
      overrides: { attachments: [], images: [], labelImages: [] },
    });
    expect(product.externalIds.length).toBeGreaterThan(0);
    render(
      <GenericEntityDetail
        entity="product"
        record={product}
        operations={operations}
      />,
      { wrapper: harness.wrapper },
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      product.name,
    );
  });

  it("derives a cohort action exactly for fields a list filter can select on", () => {
    // Manufacturer has a multiselect descriptor on product; model only a
    // text one, so it must not gain a link the list cannot honour exactly.
    const record = recordFor("product");
    const product = {
      ...record,
      manufacturer: "Milwaukee",
      model: "2853-20",
      category: categorySummaryFixture("tools"),
      tags: [],
      externalIds: [],
      ingredient: null,
      food: null,
      primaryGtin: null,
      fdc_id: null,
      cookbooks: [],
      growsPlantId: null,
    };
    render(
      <GenericEntityDetail
        entity="product"
        record={product}
        operations={operations}
      />,
      {
        wrapper: harness.wrapper,
      },
    );
    expect(
      screen.getByRole("link", {
        name: "Show all products with manufacturer Milwaukee",
      }),
    ).toHaveAttribute("href", "/products?manufacturer=Milwaukee");
    expect(
      screen.getByRole("link", {
        name: "Show all products with category Tools",
      }),
    ).toHaveAttribute("href", "/products?category=CAT-2224");
    expect(
      screen.queryByRole("link", { name: /with model/i }),
    ).not.toBeInTheDocument();
    // The category record and cohort action remain separate links.
    const categoryRecord = screen.getByRole("link", { name: "Tools" });
    const categoryFilter = screen.getByRole("link", {
      name: "Show all products with category Tools",
    });
    expect(categoryRecord.contains(categoryFilter)).toBe(false);
  });

  it("labels a book barcode as its ISBN and keeps the declared field order", () => {
    const record = recordFor("product");
    const book = {
      ...record,
      primaryGtin: "09780306406157",
      externalIds: [],
      ingredient: null,
      food: null,
      cookbooks: [],
    };
    const { container } = render(
      <GenericEntityDetail
        entity="product"
        record={book}
        operations={operations}
      />,
      { wrapper: harness.wrapper },
    );
    expect(screen.getByText("ISBN-13")).toBeVisible();
    expect(screen.getByText("9780306406157")).toBeVisible();
    expect(screen.queryByText("UPC", { exact: true })).not.toBeInTheDocument();
    const labels = Array.from(
      container.querySelectorAll(
        '#overview [data-ledger="facts"] [data-slot="basic-info-label"]',
      ),
      (element) => element.textContent,
    );
    expect(labels).toContain("Name");
    expect(labels).toContain("ISBN-13");
    const section = entitySummary.product.detail.sections.find(
      (candidate) => candidate.id === "overview",
    );
    const declared = (section?.kind === "fields" ? section.fields : []).map(
      (key) =>
        key === "primaryGtin"
          ? "ISBN-13"
          : (entityFieldModels.product.fields.find((field) => field.key === key)
              ?.label ?? key),
    );
    // Declared order, minus the fields whose value is empty on this record.
    expect(labels).toEqual(declared.filter((label) => labels.includes(label)));
  });

  it("relation section header carries the loaded count and actions", async () => {
    await harness.router.navigate({ to: "/", hash: "work" });
    const rows = [
      mock(inventoryListItem, { seed: 1 }),
      mock(inventoryListItem, { seed: 2 }),
      mock(inventoryListItem, { seed: 3 }),
    ];
    const list = entityList.list.withTransport(
      async ({ input: { entity } }) => {
        const items = entity === "inventory" ? rows : [];
        return {
          items,
          meta: {
            pageIndex: 0,
            pageSize: 50,
            totalCount: items.length,
            sums: {},
          },
        };
      },
    );
    const { container } = render(
      <GenericEntityDetail
        entity="product"
        record={recordFor("product")}
        operations={{ ...operations, list: { list } }}
      />,
      { wrapper: harness.wrapper },
    );
    const stockedAt = await waitFor(() => {
      const element = container.querySelector("section#stocked-at");
      if (!(element instanceof HTMLElement))
        throw new Error("Expected the stocked-at section to render");
      return element;
    });
    // The count only appears once the list resolves — `useSectionCount`
    // reporting through the header, not the body reaching into its own DOM.
    await within(stockedAt).findByText("3");
    expect(
      within(stockedAt).getByRole("button", { name: "New inventory item" }),
    ).toBeInTheDocument();
    expect(
      within(stockedAt).getByRole("button", { name: /Open all/ }),
    ).toBeInTheDocument();
  });

  // Empty relations retain a discoverable heading, a 0 count, and their create action.
  it("keeps a real empty relation section discoverable once its first page resolves", async () => {
    await harness.router.navigate({ to: "/", hash: "plantings" });
    const { container } = render(
      <GenericEntityDetail
        entity="product"
        record={recordFor("product")}
        operations={operations}
      />,
      { wrapper: harness.wrapper },
    );
    await waitFor(() => {
      const section = container.querySelector<HTMLElement>("section#plantings");
      expect(section).toBeVisible();
      if (!section) throw new Error("Expected the plantings section");
      expect(within(section).getByText("0", { exact: true })).toBeVisible();
    });
  });
});
