import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entitySummary } from "@cubby/schemas/entity-summary";
import {
  fieldExplanationInput,
  fieldExplanationOutput,
} from "@cubby/schemas/field-explanation";
import { imageWithEntitySchema } from "@cubby/schemas/image";
import { cookbookSummary } from "@cubby/schemas/recipe";
import { runOut } from "@cubby/schemas/run";
import { testShortcode } from "@cubby/schemas/testing";
import { TIER1_NUTRIENT_KEYS } from "@cubby/usda";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { categorySummaryFixture } from "tooling/product-category-fixtures";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getEntityDetailOutputSchema } from "~/entity/generated/entity-details.gen";
import { inventoryListItem } from "~/entity/generated/entity-lists.gen";
import { installFeatures } from "~/features/registry";
import { entityList } from "~/integrations/tanstack-query/generated/catalog/entityList.gen";
import { entityMedia } from "~/integrations/tanstack-query/generated/catalog/entityMedia.gen";
import { entityTimeline } from "~/integrations/tanstack-query/generated/catalog/entityTimeline.gen";
import { fieldExplanation } from "~/integrations/tanstack-query/generated/catalog/fieldExplanation.gen";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";
import { buildQualityBreakdown } from "~/server/generic/data-quality/repo/hydrate";

import type { DetailRecordOf, GenericDetailEntity } from "./detail-record";
import { GenericEntityDetail } from "./generic-entity-detail";

installFeatures();
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
  imageChain: fieldExplanation.explain.withTransport(async (request) => {
    const input = fieldExplanationInput.parse(request.input);
    return {
      subject: { entityKind: input.entityKind, entityId: input.entityId },
      field: "displayImages",
      label: "Display images",
      value: null,
      evaluatedAt: "2026-10-25T12:00:00Z",
      rule: {
        id: "synthetic-display-images",
        revision: 1,
        description: "Synthetic image sources",
      },
      resolution: null,
      sources: [],
      actions: [],
      truncated: false,
      imageChain: { levels: [] },
    };
  }).queryOptions,
  displayImages: entityMedia.displayImages.withTransport(async () => ({}))
    .queryOptions,
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

  it("offers Delete in an inventory detail's More actions panel", async () => {
    render(
      <GenericEntityDetail
        entity="inventory"
        record={recordFor("inventory")}
        operations={operations}
      />,
      { wrapper: harness.wrapper },
    );
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(await screen.findByRole("button", { name: "Delete" })).toBeVisible();
  });

  it.each(["product", "vendor"] as const)(
    "uses the canonical image in the %s identity when its gallery is empty",
    async (entity) => {
      const record = recordFor(entity);
      const query = entityMedia.displayImages.queryOptions({
        refs: [{ entityKind: entity, entityId: record.id }],
      });
      harness.queryClient.setQueryDefaults(query.queryKey, {
        staleTime: Infinity,
      });
      harness.queryClient.setQueryData(query.queryKey, {
        [`${entity}:${record.id}`]: {
          url: "https://images.example/brand-logo.png",
        },
      });
      render(
        <GenericEntityDetail
          entity={entity}
          record={record}
          operations={operations}
        />,
        { wrapper: harness.wrapper },
      );
      const header = screen.getByTestId("detail-spec-plate");
      await waitFor(() => {
        const image = header.querySelector(":scope > div > .shrink-0 img");
        expect(image?.getAttribute("src")).toContain("brand-logo.png");
        expect(header.querySelector("h1 svg")).toBeNull();
      });
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

  it("keeps a gated Run quality check visible with a working issue anchor", async () => {
    const record = { ...recordFor("run"), purpose: "photo_inventory" as const };
    const query = fieldExplanation.explain.queryOptions({
      entityKind: "run",
      entityId: record.id,
      field: "dataQuality",
      surface: "detail",
    });
    harness.queryClient.setQueryDefaults(query.queryKey, {
      staleTime: Infinity,
    });
    harness.queryClient.setQueryData(
      query.queryKey,
      mock(fieldExplanationOutput, {
        overrides: {
          qualityBreakdown: buildQualityBreakdown(
            ["run_target_outcomes"],
            ["run_target_outcomes"],
            [],
          ),
        },
      }),
    );
    const { container } = render(
      <GenericEntityDetail
        entity="run"
        record={record}
        operations={operations}
      />,
      { wrapper: harness.wrapper },
    );
    expect(container.querySelector("section#import-targets")).toBeNull();
    expect(await screen.findByText(/Target outcomes · Defect/)).toBeVisible();
    const jump = screen
      .getByRole("navigation", { name: "Quality issues" })
      .querySelector("a");
    expect(jump).not.toBeNull();
    expect(document.getElementById(jump!.hash.slice(1))).not.toBeNull();
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
      brandName: "Milwaukee",
      brandId: testShortcode("vendor", "VEN-TEST"),
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
        name: "Show all products with brand Milwaukee",
      }),
    ).toHaveAttribute("href", "/products?brandId=VEN-TEST");
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

  it("keeps default record facts before workflow sections despite legacy overview ids", () => {
    const { container } = render(
      <GenericEntityDetail
        entity="product"
        record={recordFor("product")}
        operations={operations}
      />,
      { wrapper: harness.wrapper },
    );
    const overview = container.querySelector("#detail-group-overview");
    const work = container.querySelector("#detail-group-work");
    if (!(overview instanceof HTMLElement) || !(work instanceof HTMLElement)) {
      throw new Error("Record Overview and Work groups must render");
    }
    // The first fields section is the record's facts aside, ahead of the
    // groups when the columns stack.
    for (const label of ["Name", "Brand", "Category"]) {
      const fact = within(container).getByText(label, {
        selector: '[data-slot="fact-label"]',
      });
      expect(
        fact.compareDocumentPosition(work) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    expect(overview.querySelector("#summaries")).not.toBeNull();
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
        '[data-ledger="facts"] [data-slot="fact-label"]',
      ),
      (element) => element.textContent,
    );
    expect(labels).toContain("Name");
    expect(labels).toContain("ISBN-13");
    for (const section of entitySummary.product.detail.sections) {
      if (section.kind !== "fields") continue;
      const sectionLabels = Array.from(
        container.querySelectorAll(
          `section#${section.id} [data-slot="fact-label"]`,
        ),
        (element) => element.textContent,
      );
      const declared = section.fields.map((key) =>
        key === "primaryGtin"
          ? "ISBN-13"
          : (entityFieldModels.product.fields.find((field) => field.key === key)
              ?.label ?? key),
      );
      expect(sectionLabels).toEqual(declared);
    }
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
